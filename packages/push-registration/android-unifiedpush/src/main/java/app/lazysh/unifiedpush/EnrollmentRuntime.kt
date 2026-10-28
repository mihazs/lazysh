package app.lazysh.unifiedpush

import android.app.Activity
import android.app.AlertDialog
import android.app.Application
import android.content.Context
import android.os.Bundle
import android.text.InputFilter
import android.text.InputType
import android.view.View
import android.view.WindowManager
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

internal object PushEnrollment {
    private var instance: EnrollmentController? = null
    @Synchronized fun controller(context: Context): EnrollmentController {
        instance?.let { return it }
        val registration = PushRegistration.controller(context)
        val gate = RegistrationEnrollmentGate(registration)
        val executor = ThreadPoolExecutor(2,2,0L,TimeUnit.MILLISECONDS,ArrayBlockingQueue(2),
            { task -> Thread(task,"lazysh-push-enrollment").apply { isDaemon=true } },ThreadPoolExecutor.AbortPolicy())
        return EnrollmentController(PrivateEnrollmentStore(context),EnrollmentHttp(),gate,executor).also { instance=it }
    }
    fun reason(context:Context):String? {
        val controller=controller(context)
        return try {
            when (controller.state()?.phase) {
                null -> null
                EnrollmentPhase.BOOTSTRAP -> "Private enrollment is pending. Connect delivery service to resume. Notifications remain disconnected."
                EnrollmentPhase.REGISTER -> "Relay enrollment prepared. Complete distributor registration; notifications remain disconnected."
                EnrollmentPhase.SUBSCRIBE, EnrollmentPhase.VERIFY -> "Waiting for an encrypted relay challenge. Notifications remain disconnected."
                EnrollmentPhase.CONFIRMED -> "Relay endpoint verified. Host event delivery and notification display remain disconnected."
                EnrollmentPhase.REVOKE_PENDING -> "Registration is paused. Private relay removal needs retry; prior remote effects remain uncertain."
                EnrollmentPhase.FAILED -> "Private relay enrollment failed. Refresh registration or pause it; notifications remain disconnected."
            }
        } catch (_:Exception) { "Private enrollment storage is unavailable. Pause registration and inspect protected storage." }
    }
}

/** A native-only credential surface. It is never saved, autofilled, captured in
 * screenshots, or returned through the WebView. Leaving the Activity cancels it. */
internal object EnrollmentDialog {
    private var current:AlertDialog?=null
    fun cancel(activity:Activity) { activity.runOnUiThread { current?.cancel() } }
    fun show(activity:Activity, previous:EnrollmentState?, submit:(String?,String?)->Unit, cancelled:()->Unit) {
        activity.runOnUiThread {
            var cleanup:(()->Unit)?=null
            try {
            current?.cancel()
            if (activity.isFinishing || activity.isDestroyed) { cancelled(); return@runOnUiThread }
            var admitted=false
            val form=LinearLayout(activity).apply { orientation=LinearLayout.VERTICAL; setPadding(32,16,32,16) }
            val explanation=TextView(activity).apply {
                text=if (previous==null) "Connect your self-hosted relay to verify an endpoint. This does not enable notifications."
                    else "Resume private enrollment with ${previous.origin}? This does not enable notifications."
            }
            fun field(hintValue:String, limit:Int, secret:Boolean)=EditText(activity).apply {
                hint=hintValue
                isSingleLine=true
                isSaveEnabled=false
                if (android.os.Build.VERSION.SDK_INT>=26) importantForAutofill=View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
                filters=arrayOf(InputFilter.LengthFilter(limit))
                inputType=if (secret) InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
                    else InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
                form.addView(this)
            }
            form.addView(explanation)
            // One extra character keeps over-limit pastes invalid rather than
            // silently truncating them into an apparently valid capability/origin.
            val origin=if (previous==null) field("HTTPS relay origin",2049,false) else null
            val capability=if (previous==null) field("One-time enrollment code",65,true) else null
            val dialog=AlertDialog.Builder(activity).setTitle(if (previous==null) "Connect delivery service" else "Resume private enrollment")
                .setView(form).setNegativeButton("Cancel") { _,_ -> }.setPositiveButton("Connect",null).create()
            checkNotNull(dialog.window).addFlags(WindowManager.LayoutParams.FLAG_SECURE)
            val lifecycle=object:Application.ActivityLifecycleCallbacks {
                override fun onActivityPaused(value:Activity) { if (value===activity) dialog.cancel() }
                override fun onActivityDestroyed(value:Activity) { if (value===activity) dialog.cancel() }
                override fun onActivityCreated(value:Activity,state:Bundle?) {}
                override fun onActivityStarted(value:Activity) {}
                override fun onActivityResumed(value:Activity) {}
                override fun onActivityStopped(value:Activity) {}
                override fun onActivitySaveInstanceState(value:Activity,state:Bundle) {}
            }
            dialog.setOnDismissListener {
                cleanup?.invoke(); cleanup=null
                origin?.text?.clear(); capability?.text?.clear()
                if (current===dialog) current=null
                if (!admitted) cancelled()
            }
            dialog.setOnShowListener {
                dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                    val url=origin?.text?.toString()
                    val code=capability?.text?.toString()
                    if (previous==null && (url==null || code==null || !validInput(url,code))) {
                        explanation.text="Enter an HTTPS origin and a 64-character hexadecimal enrollment code."
                    } else {
                        admitted=true
                        origin?.text?.clear(); capability?.text?.clear()
                        dialog.dismiss()
                        try { submit(url,code) } catch (_:Exception) { cancelled() }
                    }
                }
            }
            current=dialog
            activity.application.registerActivityLifecycleCallbacks(lifecycle)
            cleanup={activity.application.unregisterActivityLifecycleCallbacks(lifecycle)}
            dialog.show()
            } catch (_:Exception) {
                current?.dismiss()
                cleanup?.invoke()
                cancelled()
            }
        }
    }
    private fun validInput(origin:String,code:String)=try { relayOrigin(origin); capability(code) } catch (_:Exception) { false }
}
