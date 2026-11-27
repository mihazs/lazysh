---
"@lazysh/client": patch
---

perf(terminal): the native renderer repaints only the changed cells of a row

A full-screen repaint in which only a counter changes per row sends 92 % fewer instances and bytes to the GPU in the benchmark on the host GPU, with the same pixels.
