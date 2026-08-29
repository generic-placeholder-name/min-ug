use std::sync::OnceLock;

use crate::model::{Matrix, Predictor, Reader, VOCABULARY, layer_norm};

const DIMENSION: usize = 96;
const HEADS: usize = 6;
const HEAD_DIMENSION: usize = DIMENSION / HEADS;
const FEEDFORWARD: usize = 192;
const LAYERS: usize = 3;
const MAXIMUM_LENGTH: usize = 512;
const ARTIFACT: &[u8] = include_bytes!("../models/transformer-l.bin");

struct LayerWeights {
    input_projection: Matrix,
    input_bias: Vec<f32>,
    attention_projection: Matrix,
    attention_bias: Vec<f32>,
    feedforward_input: Matrix,
    feedforward_input_bias: Vec<f32>,
    feedforward_output: Matrix,
    feedforward_output_bias: Vec<f32>,
    normalization1_weight: Vec<f32>,
    normalization1_bias: Vec<f32>,
    normalization2_weight: Vec<f32>,
    normalization2_bias: Vec<f32>,
}

impl LayerWeights {
    fn load(reader: &mut Reader) -> Result<Self, ()> {
        Ok(Self {
            input_projection: reader.matrix(3 * DIMENSION, DIMENSION)?,
            input_bias: reader.vector(3 * DIMENSION)?,
            attention_projection: reader.matrix(DIMENSION, DIMENSION)?,
            attention_bias: reader.vector(DIMENSION)?,
            feedforward_input: reader.matrix(FEEDFORWARD, DIMENSION)?,
            feedforward_input_bias: reader.vector(FEEDFORWARD)?,
            feedforward_output: reader.matrix(DIMENSION, FEEDFORWARD)?,
            feedforward_output_bias: reader.vector(DIMENSION)?,
            normalization1_weight: reader.vector(DIMENSION)?,
            normalization1_bias: reader.vector(DIMENSION)?,
            normalization2_weight: reader.vector(DIMENSION)?,
            normalization2_bias: reader.vector(DIMENSION)?,
        })
    }
}

struct Weights {
    embedding: Matrix,
    position: Matrix,
    layers: Vec<LayerWeights>,
    normalization_weight: Vec<f32>,
    normalization_bias: Vec<f32>,
    output_bias: Vec<f32>,
}

impl Weights {
    fn load() -> Result<Self, ()> {
        let mut reader = Reader::new(ARTIFACT, b"MINUG2TR")?;
        let embedding = reader.matrix(VOCABULARY, DIMENSION)?;
        let position = reader.matrix(MAXIMUM_LENGTH, DIMENSION)?;
        let mut layers = Vec::with_capacity(LAYERS);
        for _ in 0..LAYERS {
            layers.push(LayerWeights::load(&mut reader)?);
        }
        let weights = Self {
            embedding,
            position,
            layers,
            normalization_weight: reader.vector(DIMENSION)?,
            normalization_bias: reader.vector(DIMENSION)?,
            output_bias: reader.vector(VOCABULARY)?,
        };
        reader.finish()?;
        Ok(weights)
    }
}

static WEIGHTS: OnceLock<Result<Weights, ()>> = OnceLock::new();

struct LayerState {
    keys: Vec<f32>,
    values: Vec<f32>,
}

pub struct Transformer {
    weights: &'static Weights,
    layers: Vec<LayerState>,
    position: usize,
}

impl Transformer {
    pub fn new() -> Result<Self, ()> {
        let weights = WEIGHTS
            .get_or_init(Weights::load)
            .as_ref()
            .map_err(|_| ())?;
        Ok(Self {
            weights,
            layers: (0..LAYERS)
                .map(|_| LayerState {
                    keys: Vec::with_capacity(MAXIMUM_LENGTH * DIMENSION),
                    values: Vec::with_capacity(MAXIMUM_LENGTH * DIMENSION),
                })
                .collect(),
            position: 0,
        })
    }
}

impl Predictor for Transformer {
    fn predict(&mut self, token: u16) -> Result<Vec<f32>, ()> {
        if self.position >= MAXIMUM_LENGTH {
            return Err(());
        }
        let mut hidden = vec![0.0; DIMENSION];
        for index in 0..DIMENSION {
            hidden[index] = self.weights.embedding.row(token as usize)[index]
                + self.weights.position.row(self.position)[index];
        }

        for layer_index in 0..LAYERS {
            let weights = &self.weights.layers[layer_index];
            let state = &mut self.layers[layer_index];
            let mut normalized = vec![0.0; DIMENSION];
            layer_norm(
                &hidden,
                &weights.normalization1_weight,
                &weights.normalization1_bias,
                &mut normalized,
            );
            let mut query_key_value = vec![0.0; 3 * DIMENSION];
            weights.input_projection.apply(
                &normalized,
                Some(&weights.input_bias),
                &mut query_key_value,
            );
            let query = &query_key_value[..DIMENSION];
            state
                .keys
                .extend_from_slice(&query_key_value[DIMENSION..2 * DIMENSION]);
            state
                .values
                .extend_from_slice(&query_key_value[2 * DIMENSION..]);

            let positions = self.position + 1;
            let mut attended = vec![0.0; DIMENSION];
            for head in 0..HEADS {
                let offset = head * HEAD_DIMENSION;
                let mut scores = vec![0.0; positions];
                for (position, score) in scores.iter_mut().enumerate() {
                    let key = &state.keys[position * DIMENSION + offset
                        ..position * DIMENSION + offset + HEAD_DIMENSION];
                    *score = query[offset..offset + HEAD_DIMENSION]
                        .iter()
                        .zip(key)
                        .map(|(left, right)| left * right)
                        .sum::<f32>()
                        / (HEAD_DIMENSION as f32).sqrt();
                }
                let maximum = scores.iter().copied().fold(f32::NEG_INFINITY, f32::max);
                let mut sum = 0.0;
                for score in &mut scores {
                    *score = (*score - maximum).exp();
                    sum += *score;
                }
                for (position, score) in scores.iter().enumerate() {
                    let value = &state.values[position * DIMENSION + offset
                        ..position * DIMENSION + offset + HEAD_DIMENSION];
                    let probability = *score / sum;
                    for index in 0..HEAD_DIMENSION {
                        attended[offset + index] += probability * value[index];
                    }
                }
            }

            let mut attention_output = vec![0.0; DIMENSION];
            weights.attention_projection.apply(
                &attended,
                Some(&weights.attention_bias),
                &mut attention_output,
            );
            for index in 0..DIMENSION {
                hidden[index] += attention_output[index];
            }

            layer_norm(
                &hidden,
                &weights.normalization2_weight,
                &weights.normalization2_bias,
                &mut normalized,
            );
            let mut feedforward = vec![0.0; FEEDFORWARD];
            weights.feedforward_input.apply(
                &normalized,
                Some(&weights.feedforward_input_bias),
                &mut feedforward,
            );
            for value in &mut feedforward {
                *value = value.max(0.0);
            }
            let mut output = vec![0.0; DIMENSION];
            weights.feedforward_output.apply(
                &feedforward,
                Some(&weights.feedforward_output_bias),
                &mut output,
            );
            for index in 0..DIMENSION {
                hidden[index] += output[index];
            }
        }

        self.position += 1;
        let mut normalized = vec![0.0; DIMENSION];
        layer_norm(
            &hidden,
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
