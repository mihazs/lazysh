# Private clipboard JNI entry points and the one fixed admission action.
-keep class app.lazysh.client.NativeClipboardAuthority { native <methods>; }
-keep class app.lazysh.client.ClipboardAdmission { public void run(); }
