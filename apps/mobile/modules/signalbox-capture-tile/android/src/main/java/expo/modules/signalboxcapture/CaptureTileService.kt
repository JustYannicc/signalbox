package expo.modules.signalboxcapture

import android.app.PendingIntent
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService

class CaptureTileService : TileService() {
  override fun onTileAdded() {
    super.onTileAdded()
    CaptureTileState.setAdded(this, true)
  }

  override fun onTileRemoved() {
    super.onTileRemoved()
    CaptureTileState.setAdded(this, false)
  }

  override fun onStartListening() {
    super.onStartListening()
    CaptureTileState.setAdded(this, true)
    qsTile?.apply {
      state = Tile.STATE_INACTIVE
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        subtitle = applicationInfo.loadLabel(packageManager)
      }
      updateTile()
    }
  }

  override fun onClick() {
    super.onClick()
    if (isLocked) unlockAndRun { openCapture() } else openCapture()
  }

  @Suppress("DEPRECATION")
  private fun openCapture() {
    val intent = CaptureTileIntent.create(this) ?: return
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      startActivityAndCollapse(
        PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
      )
    } else {
      startActivityAndCollapse(intent)
    }
  }
}
