from __future__ import annotations

import unittest

import torch

from training.byte_models import (
    DELIMITER_TOKEN,
    URL_BYTE_ALPHABET,
    URL_BYTE_TO_TOKEN,
    ByteGRU,
    ByteGRULocal,
    ByteLSTM,
    ByteMLP,
    ByteSLSTM,
    ByteTransformer,
    ByteUnigram,
    HashedByteNGram,
    tokenize_urls,
)


class ByteModelTests(unittest.TestCase):
    def test_canonical_alphabet_is_a_bijection_over_91_bytes_plus_eof(self) -> None:
        self.assertEqual(len(URL_BYTE_ALPHABET), 91)
        self.assertEqual(len(set(URL_BYTE_ALPHABET)), 91)
        self.assertEqual(DELIMITER_TOKEN, 91)
        for token, byte in enumerate(URL_BYTE_ALPHABET):
            self.assertEqual(URL_BYTE_TO_TOKEN[byte], token)

    def test_tokenization_round_trip_layout_and_length_limit(self) -> None:
        urls = torch.tensor([[97, 98, 99], [120, 0, 0]], dtype=torch.uint8)
        lengths = torch.tensor([3, 1], dtype=torch.int32)
        batch, excluded = tokenize_urls(urls, lengths, maximum_length=3)
        self.assertEqual(excluded, 1)
        assert batch is not None
        x = URL_BYTE_TO_TOKEN[ord("x")]
        self.assertEqual(batch.inputs.tolist(), [[DELIMITER_TOKEN, x]])
        self.assertEqual(batch.targets.tolist(), [[x, DELIMITER_TOKEN]])

    def test_tokenization_rejects_bytes_outside_canonical_http_urls(self) -> None:
        urls = torch.tensor([[0xC3, 0xA9]], dtype=torch.uint8)
        lengths = torch.tensor([2], dtype=torch.int32)
        with self.assertRaisesRegex(ValueError, "unsupported raw byte 0xc3"):
            tokenize_urls(urls, lengths, maximum_length=8)

    def test_mlp_is_causal(self) -> None:
        torch.manual_seed(1)
        model = ByteMLP(context=4, embedding=8, hidden=16).eval()
        first = torch.tensor([[DELIMITER_TOKEN, 1, 2, 3, 4]])
        second = first.clone()
        second[0, 4] = 10
        with torch.inference_mode():
            before = model(first)
            after = model(second)
        torch.testing.assert_close(before[:, :4], after[:, :4])

    def test_gru_is_causal(self) -> None:
        torch.manual_seed(1)
        model = ByteGRU(embedding=8, hidden=16).eval()
        first = torch.tensor([[DELIMITER_TOKEN, 1, 2, 3, 4]])
        second = first.clone()
        second[0, 4] = 10
        with torch.inference_mode():
            before = model(first)
            after = model(second)
        torch.testing.assert_close(before[:, :4], after[:, :4])

    def test_lstm_is_causal(self) -> None:
        torch.manual_seed(1)
        model = ByteLSTM(embedding=8, hidden=16).eval()
        self.assert_model_is_causal(model)

    def test_gru_local_is_causal(self) -> None:
        torch.manual_seed(1)
        model = ByteGRULocal(
            context=4,
            embedding=8,
            hidden=16,
            local_hidden=16,
        ).eval()
        self.assert_model_is_causal(model)

    def test_slstm_is_causal_and_finite(self) -> None:
        torch.manual_seed(1)
        model = ByteSLSTM(embedding=8, hidden=16).eval()
        before, after = self.model_outputs_after_future_change(model)
        torch.testing.assert_close(before[:, :4], after[:, :4])
        self.assertTrue(bool(torch.isfinite(before).all()))

    def test_slstm_stabilizes_a_maximum_length_sequence(self) -> None:
        torch.manual_seed(1)
        model = ByteSLSTM(embedding=8, hidden=16).eval()
        inputs = torch.randint(0, DELIMITER_TOKEN + 1, (2, 512))
        with torch.inference_mode():
            outputs = model(inputs)
        self.assertEqual(outputs.shape, (2, 512, DELIMITER_TOKEN + 1))
        self.assertTrue(bool(torch.isfinite(outputs).all()))

    @staticmethod
    def model_outputs_after_future_change(
        model: torch.nn.Module,
    ) -> tuple[torch.Tensor, torch.Tensor]:
        first = torch.tensor([[DELIMITER_TOKEN, 1, 2, 3, 4]])
        second = first.clone()
        second[0, 4] = 10
        with torch.inference_mode():
            return model(first), model(second)

    def assert_model_is_causal(self, model: torch.nn.Module) -> None:
        before, after = self.model_outputs_after_future_change(model)
        torch.testing.assert_close(before[:, :4], after[:, :4])

    def test_transformer_is_causal(self) -> None:
        torch.manual_seed(1)
        model = ByteTransformer(
            dimension=16,
            heads=4,
            layers=1,
            feedforward=32,
            maximum_length=8,
        ).eval()
        first = torch.tensor([[DELIMITER_TOKEN, 1, 2, 3, 4]])
        second = first.clone()
        second[0, 4] = 10
        valid = torch.ones_like(first, dtype=torch.bool)
        with torch.inference_mode():
            before = model(first, valid)
            after = model(second, valid)
        torch.testing.assert_close(before[:, :4], after[:, :4], atol=1e-6, rtol=1e-6)

    def test_ngram_uses_context(self) -> None:
        urls = torch.tensor([[97, 98], [97, 98], [97, 99]], dtype=torch.uint8)
        lengths = torch.tensor([2, 2, 2], dtype=torch.int32)
        batch, excluded = tokenize_urls(urls, lengths, maximum_length=8)
        self.assertEqual(excluded, 0)
        assert batch is not None
        unigram = ByteUnigram(device=torch.device("cpu"))
        ngram = HashedByteNGram(order=2, buckets=(257, 1024), device=torch.device("cpu"))
        for _ in range(20):
            unigram.update(batch)
            ngram.update(batch)
        self.assertLess(float(ngram.bits(batch).mean()), float(unigram.bits(batch).mean()))


if __name__ == "__main__":
    unittest.main()
