# Public speech acceptance fixture

This is LibriSpeech dev-clean utterance `1272-128104-0000`, not user audio. LibriSpeech (c) 2014 Vassil Panayotov is distributed under **CC-BY-4.0**; the original corpus notice is in [LICENSE.TXT](LICENSE.TXT). Credit: Vassil Panayotov, Daniel Povey and the LibriSpeech/LibriVox contributors. [Original corpus and license](https://www.openslr.org/12), [CC-BY-4.0 terms](https://creativecommons.org/licenses/by/4.0/).

Source: `https://openslr.trmal.net/resources/12/dev-clean.tar.gz`. Its [published MD5](https://openslr.trmal.net/resources/12/md5sum.txt) is `42e2234ba48799c1f50f24a7926300a1`, independently checked on download. Observed archive SHA-256: `76f87d090650617fca0cac8f88b9416e0ebf80350acb97b343a85fa903728ab3`. MD5 is recorded as publisher provenance, not a modern cryptographic authenticity guarantee.

The original `LibriSpeech/dev-clean/1272/128104/1272-128104-0000.flac` has SHA-256 `4e25e22555cd16e90edb0a3b49fdcf1fe652b2a1250ab643634db33895c75b41`. It was losslessly decoded using the standard `flac 1.5.0` decoder to the included WAV; no resampling, cropping or speech changes. The 187,404-byte WAV has SHA-256 `799f78ed4beb4de7ceae3a809262d4ce242394342ccd1d58cef7d49dbc2def46`: 93,680 frames of mono 16 kHz, signed 16-bit PCM (5.855 seconds).

`reference.txt` is the original utterance's 17-word transcript from the corpus's `1272-128104.trans.txt`, with only its utterance ID removed. It is independent of Parakeet's output. Acceptance uses case/punctuation normalization and word error rate <= 0.10, chosen before running inference. A single clean English sample does not establish general accuracy, multilingual support, device performance or cancellation behavior.
