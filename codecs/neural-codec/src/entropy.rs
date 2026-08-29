use crate::model::VOCABULARY;

const PRECISION_BITS: u32 = 12;
const TOTAL: u32 = 1 << PRECISION_BITS;
#[cfg(any(feature = "arithmetic", test))]
const HALF: u32 = 0x8000_0000;
#[cfg(any(feature = "arithmetic", test))]
const FIRST_QUARTER: u32 = 0x4000_0000;
#[cfg(any(feature = "arithmetic", test))]
const THIRD_QUARTER: u32 = 0xc000_0000;

pub type CumulativeFrequencies = [u16; VOCABULARY + 1];

pub fn cumulative_frequencies(logits: &[f32]) -> Result<CumulativeFrequencies, ()> {
    if logits.len() != VOCABULARY || logits.iter().any(|value| !value.is_finite()) {
        return Err(());
    }
    let maximum = logits.iter().copied().fold(f32::NEG_INFINITY, f32::max);
    let mut weights = [0_u32; VOCABULARY];
    let mut sum = 0_u64;
    for (index, logit) in logits.iter().enumerate() {
        let exponent = (*logit - maximum).clamp(-16.0, 0.0).exp();
        let weight = (exponent * 16_777_216.0).round().max(1.0) as u32;
        weights[index] = weight;
        sum += weight as u64;
    }

    let distributable = TOTAL as u64 - VOCABULARY as u64;
    let mut cumulative_weight = 0_u64;
    let mut cumulative = [0_u16; VOCABULARY + 1];
    for index in 0..VOCABULARY {
        cumulative_weight += weights[index] as u64;
        let allocated = (cumulative_weight * distributable + sum / 2) / sum;
        cumulative[index + 1] = (index as u64 + 1 + allocated) as u16;
    }
    if cumulative[VOCABULARY] != TOTAL as u16 {
        return Err(());
    }
    Ok(cumulative)
}

#[cfg(any(feature = "arithmetic", test))]
struct BitWriter {
    bytes: Vec<u8>,
    current: u8,
    used: u8,
}

#[cfg(any(feature = "arithmetic", test))]
impl BitWriter {
    fn new() -> Self {
        Self {
            bytes: Vec::new(),
            current: 0,
            used: 0,
        }
    }

    fn bit(&mut self, value: bool) {
        self.current = (self.current << 1) | value as u8;
        self.used += 1;
        if self.used == 8 {
            self.bytes.push(self.current);
            self.current = 0;
            self.used = 0;
        }
    }

    fn finish(mut self) -> Vec<u8> {
        if self.used != 0 {
            self.current <<= 8 - self.used;
            self.bytes.push(self.current);
        }
        self.bytes
    }
}

#[cfg(any(feature = "arithmetic", test))]
pub struct ArithmeticEncoder {
    low: u32,
    high: u32,
    pending: usize,
    writer: BitWriter,
}

#[cfg(any(feature = "arithmetic", test))]
impl ArithmeticEncoder {
    pub fn new() -> Self {
        Self {
            low: 0,
            high: u32::MAX,
            pending: 0,
            writer: BitWriter::new(),
        }
    }

    fn emit(&mut self, value: bool) {
        self.writer.bit(value);
        for _ in 0..self.pending {
            self.writer.bit(!value);
        }
        self.pending = 0;
    }

    pub fn symbol(&mut self, symbol: usize, cumulative: &[u16; VOCABULARY + 1]) {
        let range = self.high as u64 - self.low as u64 + 1;
        let lower = cumulative[symbol] as u64;
        let upper = cumulative[symbol + 1] as u64;
        self.high = (self.low as u64 + range * upper / TOTAL as u64 - 1) as u32;
        self.low = (self.low as u64 + range * lower / TOTAL as u64) as u32;

        loop {
            if self.high < HALF {
                self.emit(false);
            } else if self.low >= HALF {
                self.emit(true);
                self.low -= HALF;
                self.high -= HALF;
            } else if self.low >= FIRST_QUARTER && self.high < THIRD_QUARTER {
                self.pending += 1;
                self.low -= FIRST_QUARTER;
                self.high -= FIRST_QUARTER;
            } else {
                break;
            }
            self.low <<= 1;
            self.high = (self.high << 1) | 1;
        }
    }

    pub fn finish(mut self) -> Vec<u8> {
        self.pending += 1;
        self.emit(self.low >= FIRST_QUARTER);
        self.writer.finish()
    }
}

#[cfg(any(feature = "arithmetic", test))]
struct BitReader<'a> {
    bytes: &'a [u8],
    position: usize,
}

#[cfg(any(feature = "arithmetic", test))]
impl<'a> BitReader<'a> {
    fn bit(&mut self) -> u32 {
        let byte = self.position / 8;
        let offset = 7 - self.position % 8;
        self.position += 1;
        self.bytes
            .get(byte)
            .map_or(0, |value| ((value >> offset) & 1) as u32)
    }
}

#[cfg(any(feature = "arithmetic", test))]
pub struct ArithmeticDecoder<'a> {
    low: u32,
    high: u32,
    code: u32,
    reader: BitReader<'a>,
}

pub struct Encoder {
    symbols: Vec<usize>,
    distributions: Vec<CumulativeFrequencies>,
}

impl Encoder {
    pub fn new() -> Self {
        Self {
            symbols: Vec::new(),
            distributions: Vec::new(),
        }
    }

    pub fn symbol(&mut self, symbol: usize, cumulative: CumulativeFrequencies) {
        self.symbols.push(symbol);
        self.distributions.push(cumulative);
    }

    #[cfg(feature = "arithmetic")]
    pub fn finish(self) -> Result<Vec<u8>, ()> {
        let mut encoder = ArithmeticEncoder::new();
        for (symbol, cumulative) in self.symbols.into_iter().zip(&self.distributions) {
            encoder.symbol(symbol, cumulative);
        }
        Ok(encoder.finish())
    }

    #[cfg(feature = "rans")]
    pub fn finish(self) -> Result<Vec<u8>, ()> {
        let mut encoder = ans::RansEncoder::with_capacity(self.symbols.len());
        for (symbol, cumulative) in self.symbols.into_iter().zip(self.distributions).rev() {
            let table = rans_table(&cumulative)?;
            encoder.put(symbol as u32, &table).map_err(|_| ())?;
        }
        Ok(encoder.finish())
    }
}

pub struct Decoder<'a> {
    #[cfg(feature = "arithmetic")]
    inner: ArithmeticDecoder<'a>,
    #[cfg(feature = "rans")]
    inner: ans::RansDecoder<'a>,
}

impl<'a> Decoder<'a> {
    #[cfg(feature = "arithmetic")]
    pub fn new(bytes: &'a [u8]) -> Result<Self, ()> {
        Ok(Self {
            inner: ArithmeticDecoder::new(bytes),
        })
    }

    #[cfg(feature = "rans")]
    pub fn new(bytes: &'a [u8]) -> Result<Self, ()> {
        Ok(Self {
            inner: ans::RansDecoder::new(bytes).map_err(|_| ())?,
        })
    }

    #[cfg(feature = "arithmetic")]
    pub fn symbol(&mut self, cumulative: &CumulativeFrequencies) -> Result<usize, ()> {
        self.inner.symbol(cumulative)
    }

    #[cfg(feature = "rans")]
    pub fn symbol(&mut self, cumulative: &CumulativeFrequencies) -> Result<usize, ()> {
        let table = rans_table(cumulative)?;
        usize::try_from(self.inner.get(&table).map_err(|_| ())?).map_err(|_| ())
    }

    #[cfg(feature = "arithmetic")]
    pub fn finish(&self) -> Result<(), ()> {
        Ok(())
    }

    #[cfg(feature = "rans")]
    pub fn finish(&self) -> Result<(), ()> {
        if self.inner.remaining_bytes() == 0
            && self.inner.state() == ans::RansEncoder::new().state()
        {
            Ok(())
        } else {
            Err(())
        }
    }
}

#[cfg(feature = "rans")]
fn rans_table(cumulative: &CumulativeFrequencies) -> Result<ans::FrequencyTable, ()> {
    let frequencies: Vec<u32> = cumulative
        .windows(2)
        .map(|pair| u32::from(pair[1] - pair[0]))
        .collect();
    ans::FrequencyTable::from_normalized(&frequencies, PRECISION_BITS).map_err(|_| ())
}

#[cfg(any(feature = "arithmetic", test))]
impl<'a> ArithmeticDecoder<'a> {
    pub fn new(bytes: &'a [u8]) -> Self {
        let mut reader = BitReader { bytes, position: 0 };
        let mut code = 0_u32;
        for _ in 0..32 {
            code = (code << 1) | reader.bit();
        }
        Self {
            low: 0,
            high: u32::MAX,
            code,
            reader,
        }
    }

    pub fn symbol(&mut self, cumulative: &CumulativeFrequencies) -> Result<usize, ()> {
        let range = self.high as u64 - self.low as u64 + 1;
        let scaled = (((self.code as u64 - self.low as u64 + 1) * TOTAL as u64 - 1) / range) as u16;
        let symbol = cumulative
            .partition_point(|value| *value <= scaled)
            .saturating_sub(1);
        if symbol >= VOCABULARY {
            return Err(());
        }
        let lower = cumulative[symbol] as u64;
        let upper = cumulative[symbol + 1] as u64;
        self.high = (self.low as u64 + range * upper / TOTAL as u64 - 1) as u32;
        self.low = (self.low as u64 + range * lower / TOTAL as u64) as u32;

        loop {
            if self.high < HALF {
            } else if self.low >= HALF {
                self.code -= HALF;
                self.low -= HALF;
                self.high -= HALF;
            } else if self.low >= FIRST_QUARTER && self.high < THIRD_QUARTER {
                self.code -= FIRST_QUARTER;
                self.low -= FIRST_QUARTER;
                self.high -= FIRST_QUARTER;
            } else {
                break;
            }
            self.low <<= 1;
            self.high = (self.high << 1) | 1;
            self.code = (self.code << 1) | self.reader.bit();
        }
        Ok(symbol)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn varying_distributions_round_trip() {
        let symbols = [91, 40, 55, 55, 51, 54, 25, 14, 14, 0, 90, 91];
        let distributions: Vec<_> = symbols
            .iter()
            .enumerate()
            .map(|(step, symbol)| {
                let mut logits = vec![-4.0; VOCABULARY];
                logits[*symbol] = 2.0 + step as f32 / 10.0;
                cumulative_frequencies(&logits).unwrap()
            })
            .collect();
        let mut encoder = ArithmeticEncoder::new();
        for (symbol, cumulative) in symbols.iter().zip(&distributions) {
            encoder.symbol(*symbol, cumulative);
        }
        let payload = encoder.finish();
        let mut decoder = ArithmeticDecoder::new(&payload);
        let decoded: Vec<_> = distributions
            .iter()
            .map(|cumulative| decoder.symbol(cumulative).unwrap())
            .collect();
        assert_eq!(decoded, symbols);
    }

    #[test]
    fn frequency_table_is_positive_and_exact() {
        let logits: Vec<_> = (0..VOCABULARY)
            .map(|index| index as f32 / 17.0 - 8.0)
            .collect();
        let cumulative = cumulative_frequencies(&logits).unwrap();
        assert_eq!(cumulative[0], 0);
        assert_eq!(cumulative[VOCABULARY], TOTAL as u16);
        assert!(cumulative.windows(2).all(|pair| pair[0] < pair[1]));
    }

    #[test]
    fn selected_entropy_coder_round_trips_varying_distributions() {
        let symbols = [91, 40, 55, 55, 51, 54, 25, 14, 14, 0, 90, 91];
        let distributions: Vec<_> = symbols
            .iter()
            .enumerate()
            .map(|(step, symbol)| {
                let mut logits = vec![-4.0; VOCABULARY];
                logits[*symbol] = 2.0 + step as f32 / 10.0;
                cumulative_frequencies(&logits).unwrap()
            })
            .collect();
        let mut encoder = Encoder::new();
        for (symbol, cumulative) in symbols.iter().zip(distributions.iter().copied()) {
            encoder.symbol(*symbol, cumulative);
        }
        let payload = encoder.finish().unwrap();
        let mut decoder = Decoder::new(&payload).unwrap();
        let decoded: Vec<_> = distributions
            .iter()
            .map(|cumulative| decoder.symbol(cumulative).unwrap())
            .collect();
        assert_eq!(decoded, symbols);
        decoder.finish().unwrap();
    }
}
