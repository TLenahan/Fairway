package expo.modules.practicekeepalive

import android.content.Context
import android.content.Intent
import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * JS-facing control for the practice keep-alive foreground service: keeps the
 * process, CPU, and Wi-Fi radio alive while the screen is off so the EYE MINI
 * TCP/UDP connection keeps streaming shots.
 */
class PracticeKeepAliveModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("PracticeKeepAlive")

    Function("start") { title: String, body: String ->
      val context: Context? = appContext.reactContext
      if (context != null) {
        val intent = Intent(context, PracticeKeepAliveService::class.java)
        intent.putExtra("title", title)
        intent.putExtra("body", body)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          context.startForegroundService(intent)
        } else {
          context.startService(intent)
        }
      }
    }

    Function("stop") {
      val context: Context? = appContext.reactContext
      if (context != null) {
        context.stopService(Intent(context, PracticeKeepAliveService::class.java))
      }
    }
  }
}
