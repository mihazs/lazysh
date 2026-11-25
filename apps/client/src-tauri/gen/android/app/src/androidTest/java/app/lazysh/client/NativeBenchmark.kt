package app.lazysh.client

internal object NativeBenchmark {
    /** Presented byte watermark, its CLOCK_MONOTONIC timestamp, and current parsed input bytes. */
    @JvmStatic external fun presented(session: String): LongArray?
}
