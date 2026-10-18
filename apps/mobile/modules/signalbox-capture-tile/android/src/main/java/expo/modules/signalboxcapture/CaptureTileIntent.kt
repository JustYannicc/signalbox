package expo.modules.signalboxcapture

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri

internal object CaptureTileIntent {
  const val SCHEME_METADATA = "com.signalbox.capture.SCHEME"

  @Suppress("DEPRECATION")
  fun create(context: Context): Intent? {
    val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return null
    val info = context.packageManager.getApplicationInfo(context.packageName, PackageManager.GET_META_DATA)
    val scheme = info.metaData?.getString(SCHEME_METADATA)?.takeIf { it.isNotBlank() } ?: return null
    return forCapture(launch, scheme)
  }

  fun forCapture(launch: Intent, scheme: String): Intent = Intent(launch).apply {
    action = Intent.ACTION_VIEW
    data = Uri.Builder().scheme(scheme).authority("capture").build()
    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
  }
}
