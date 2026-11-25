package app.lazysh.client

internal object NativeSoftwareGpu {
    @JvmStatic external fun swap(enabled: Boolean): Boolean
}
