package expo.modules.signalboxcapture

import android.app.Activity
import android.app.StatusBarManager
import android.content.ComponentName
import android.graphics.drawable.Icon
import android.os.Build
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class CaptureTileModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("SignalboxCaptureTile")

    Function("isAdded") {
      appContext.reactContext?.let(CaptureTileState::isAdded) ?: false
    }

    AsyncFunction("requestAddTile") { promise: Promise ->
      requestAddTile(appContext.currentActivity, promise)
    }
  }
}

internal fun requestAddTile(activity: Activity?, promise: Promise) {
  if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
    promise.resolve("unsupported")
    return
  }
  if (activity == null) {
    promise.reject("CAPTURE_TILE_NO_ACTIVITY", "Open Signalbox before adding its Capture tile.", null)
    return
  }
  activity.runOnUiThread {
    try {
      activity.getSystemService(StatusBarManager::class.java).requestAddTileService(
        ComponentName(activity, CaptureTileService::class.java),
        activity.getString(R.string.signalbox_capture_label),
        Icon.createWithResource(activity, R.drawable.signalbox_capture_tile),
        activity.mainExecutor
      ) { result ->
        when (result) {
          StatusBarManager.TILE_ADD_REQUEST_RESULT_TILE_ADDED,
          StatusBarManager.TILE_ADD_REQUEST_RESULT_TILE_ALREADY_ADDED -> {
            CaptureTileState.setAdded(activity, true)
            promise.resolve("added")
          }
          StatusBarManager.TILE_ADD_REQUEST_RESULT_TILE_NOT_ADDED -> promise.resolve("cancelled")
          else -> promise.reject(
            "CAPTURE_TILE_ADD_FAILED",
            "Couldn't add Capture to Quick Settings. Try again.",
            null
          )
        }
      }
    } catch (error: Exception) {
      promise.reject("CAPTURE_TILE_ADD_FAILED", "Couldn't add Capture to Quick Settings. Try again.", error)
    }
  }
}
