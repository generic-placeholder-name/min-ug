use std::sync::OnceLock;

use crate::model::{Matrix, Predictor, Reader, VOCABULARY, layer_norm};

const EMBEDDING: usize = 96;
const HIDDEN: usize = 256;
const GATES: usize = 3 * HIDDEN;
const ARTIFACT: &[u8] = include_bytes!("../models/gru-l.bin");

struct Weights {
    embedding: Matrix,
    input: Matrix,
    recurrent: Matrix,
    input_bias: Vec<f32>,
    recurrent_bias: Vec<f32>,
    projection: Matrix,
    normalization_weight: Vec<f32>,
    normalization_bias: Vec<f32>,
    output_bias: Vec<f32>,
}

impl Weights {
    fn load() -> Result<Self, ()> {
        let mut reader = Reader::new(ARTIFACT, b"MINUG2GR")?;
        let weights = Self {
            embedding: reader.matrix(VOCABULARY, EMBEDDING)?,
            input: reader.matrix(GATES, EMBEDDING)?,
            recurrent: reader.matrix(GATES, HIDDEN)?,
            input_bias: reader.vector(GATES)?,
            recurrent_bias: reader.vector(GATES)?,
            projection: reader.matrix(EMBEDDING, HIDDEN)?,
            normalization_weight: reader.vector(EMBEDDING)?,
            normalization_bias: reader.vector(EMBEDDING)?,
            output_bias: reader.vector(VOCABULARY)?,
        };
        reader.finish()?;
        Ok(weights)
    }
}

static WEIGHTS: OnceLock<Result<Weights, ()>> = OnceLock::new();

pub struct Gru {
    weights: &'static Weights,
    hidden: Vec<f32>,
}

impl Gru {
    pub fn new() -> Result<Self, ()> {
        let weights = WEIGHTS
            .get_or_init(Weights::load)
            .as_ref()
            .map_err(|_| ())?;
        Ok(Self {
            weights,
            hidden: vec![0.0; HIDDEN],
        })
    }
}

fn sigmoid(value: f32) -> f32 {
    1.0 / (1.0 + (-value).exp())
}

impl Predictor for Gru {
    fn predict(&mut self, token: u16) -> Result<Vec<f32>, ()> {
        let embedded = self.weights.embedding.row(token as usize);
        let mut input = vec![0.0; GATES];
        let mut recurrent = vec![0.0; GATES];
        self.weights
            .input
            .apply(embedded, Some(&self.weights.input_bias), &mut input);
        self.weights.recurrent.apply(
            &self.hidden,
            Some(&self.weights.recurrent_bias),
            &mut recurrent,
        );
        for index in 0..HIDDEN {
            let reset = sigmoid(input[index] + recurrent[index]);
            let update = sigmoid(input[HIDDEN + index] + recurrent[HIDDEN + index]);
            let candidate =
                (input[2 * HIDDEN + index] + reset * recurrent[2 * HIDDEN + index]).tanh();
            self.hidden[index] = (1.0 - update) * candidate + update * self.hidden[index];
        }

        let mut projected = vec![0.0; EMBEDDING];
        self.weights
            .projection
            .apply(&self.hidden, None, &mut projected);
        let mut normalized = vec![0.0; EMBEDDING];
        layer_norm(
            &projected,
            &self.weights.normalization_weight,
            &self.weights.normalization_bias,
            &mut normalized,
        );
        let mut logits = vec![0.0; VOCABULARY];
        self.weights
            .embedding
            .apply(&normalized, Some(&self.weights.output_bias), &mut logits);
        Ok(logits)
    }
}
