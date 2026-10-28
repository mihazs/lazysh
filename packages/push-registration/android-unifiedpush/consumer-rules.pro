# Fixed JNI names called by the app's original-access consent gate.
-keep class app.lazysh.unifiedpush.NativeDisplayAuthority { native <methods>; }
-keep class app.lazysh.unifiedpush.DisplayConsentCommit { public void run(); }
