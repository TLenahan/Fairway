package expo.modules.practicekeepalive

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat

/**
 * connectedDevice foreground service holding a partial wake lock (CPU/JS keep
 * running with the screen off) and a high-perf Wi-Fi lock (the radio stays
 * out of power-save, which otherwise drops idle LAN sockets on Pixels).
 * Personal-use app — no Play policy review applies to the FGS type.
 */
class PracticeKeepAliveService : Service() {
  private var wakeLock: PowerManager.WakeLock? = null
  private var wifiLock: WifiManager.WifiLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val channelId = "practice-keepalive"
    val manager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      manager.createNotificationChannel(
        NotificationChannel(
          channelId,
          "Practice session",
          NotificationManager.IMPORTANCE_LOW,
        ),
      )
    }

    val title = intent?.getStringExtra("title") ?: "Fairway connected"
    val body = intent?.getStringExtra("body") ?: "Streaming shots from the EYE MINI"
    val notification = NotificationCompat.Builder(this, channelId)
      .setContentTitle(title)
      .setContentText(body)
      .setSmallIcon(applicationInfo.icon)
      .setOngoing(true)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .build()

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(
        NOTIFICATION_ID,
        notification,
        ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE,
      )
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }

    if (wakeLock == null) {
      val power = getSystemService(POWER_SERVICE) as PowerManager
      wakeLock = power
        .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "fairway:practice")
        .apply { acquire() }
    }
    if (wifiLock == null) {
      val wifi = applicationContext.getSystemService(WIFI_SERVICE) as WifiManager
      @Suppress("DEPRECATION") // FULL_HIGH_PERF: still the right lock for LAN streaming
      wifiLock = wifi
        .createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "fairway:wifi")
        .apply { acquire() }
    }
    return START_STICKY
  }

  override fun onDestroy() {
    wakeLock?.takeIf { it.isHeld }?.release()
    wifiLock?.takeIf { it.isHeld }?.release()
    wakeLock = null
    wifiLock = null
    super.onDestroy()
  }

  companion object {
    private const val NOTIFICATION_ID = 1001
  }
}
