pub const URL_BYTE_ALPHABET: &[u8; 91] =
    b"!#$%&'()*+,-./0123456789:;=?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~";
pub const VOCABULARY: usize = URL_BYTE_ALPHABET.len() + 1;
pub const DELIMITER: u16 = URL_BYTE_ALPHABET.len() as u16;
pub const MAXIMUM_URL_BYTES: usize = 511;

pub fn byte_to_token(byte: u8) -> Option<u16> {
    URL_BYTE_ALPHABET
        .iter()
        .position(|candidate| *candidate == byte)
        .map(|token| token as u16)
}

pub fn token_to_byte(token: usize) -> Option<u8> {
    URL_BYTE_ALPHABET.get(token).copied()
}

pub struct Reader {
    bytes: &'static [u8],
    offset: usize,
}

impl Reader {
    pub fn new(bytes: &'static [u8], header: &[u8; 8]) -> Result<Self, ()> {
        if bytes.get(..8) != Some(header) {
            return Err(());
        }
        let alphabet_end = 8 + URL_BYTE_ALPHABET.len();
        if bytes.get(8..alphabet_end) != Some(URL_BYTE_ALPHABET) {
            return Err(());
        }
        Ok(Self {
            bytes,
            offset: alphabet_end,
        })
    }

    fn bytes(&mut self, count: usize) -> Result<&'static [u8], ()> {
        let end = self.offset.checked_add(count).ok_or(())?;
        let value = self.bytes.get(self.offset..end).ok_or(())?;
        self.offset = end;
        Ok(value)
    }

    pub fn vector(&mut self, count: usize) -> Result<Vec<f32>, ()> {
        let bytes = self.bytes(count.checked_mul(4).ok_or(())?)?;
        Ok(bytes
            .chunks_exact(4)
            .map(|chunk| f32::from_le_bytes(chunk.try_into().unwrap()))
            .collect())
    }

    pub fn matrix(&mut self, rows: usize, columns: usize) -> Result<Matrix, ()> {
        let scales = self.vector(rows)?;
        let quantized = self.bytes(rows.checked_mul(columns).ok_or(())?)?;
        let mut values = Vec::with_capacity(quantized.len());
        for (row, bytes) in quantized.chunks_exact(columns).enumerate() {
            let scale = scales[row];
            values.extend(bytes.iter().map(|value| (*value as i8) as f32 * scale));
        }
        Ok(Matrix {
            rows,
            columns,
            values,
        })
    }

    pub fn finish(self) -> Result<(), ()> {
        if self.offset == self.bytes.len() {
            Ok(())
        } else {
            Err(())
        }
    }
}

pub struct Matrix {
    rows: usize,
    columns: usize,
    values: Vec<f32>,
}

impl Matrix {
    pub fn row(&self, row: usize) -> &[f32] {
        let start = row * self.columns;
        &self.values[start..start + self.columns]
    }

    pub fn apply(&self, input: &[f32], bias: Option<&[f32]>, output: &mut [f32]) {
        debug_assert_eq!(input.len(), self.columns);
        debug_assert_eq!(output.len(), self.rows);
        for (row, destination) in output.iter_mut().enumerate() {
            let weights = self.row(row);
            let mut total = bias.map_or(0.0, |values| values[row]);
            for index in 0..self.columns {
                total += weights[index] * input[index];
            }
            *destination = total;
        }
    }
}

pub fn layer_norm(input: &[f32], weight: &[f32], bias: &[f32], output: &mut [f32]) {
    let mean = input.iter().sum::<f32>() / input.len() as f32;
    let variance = input
        .iter()
        .map(|value| {
            let centered = value - mean;
            centered * centered
        })
        .sum::<f32>()
        / input.len() as f32;
    let inverse = 1.0 / (variance + 1e-5).sqrt();
    for index in 0..input.len() {
        output[index] = (input[index] - mean) * inverse * weight[index] + bias[index];
    }
}

pub trait Predictor {
    fn predict(&mut self, token: u16) -> Result<Vec<f32>, ()>;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn artifact_with_alphabet(alphabet: &[u8]) -> &'static [u8] {
        let mut bytes = b"MINUG2GR".to_vec();
        bytes.extend_from_slice(alphabet);
        Box::leak(bytes.into_boxed_slice())
    }

    #[test]
    fn alphabet_is_unique_and_round_trips() {
        let mut sorted = URL_BYTE_ALPHABET.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), URL_BYTE_ALPHABET.len());
        for (token, byte) in URL_BYTE_ALPHABET.iter().copied().enumerate() {
            assert_eq!(byte_to_token(byte), Some(token as u16));
            assert_eq!(token_to_byte(token), Some(byte));
        }
        assert_eq!(token_to_byte(DELIMITER as usize), None);
        assert_eq!(byte_to_token(b' '), None);
    }

    #[test]
    fn model_artifact_must_declare_the_identical_alphabet() {
        assert!(Reader::new(artifact_with_alphabet(URL_BYTE_ALPHABET), b"MINUG2GR").is_ok());
        let mut changed = URL_BYTE_ALPHABET.to_vec();
        changed.swap(0, 1);
        assert!(Reader::new(artifact_with_alphabet(&changed), b"MINUG2GR").is_err());
    }
}
