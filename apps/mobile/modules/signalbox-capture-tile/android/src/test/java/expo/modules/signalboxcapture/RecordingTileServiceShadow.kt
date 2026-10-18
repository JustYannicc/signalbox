package expo.modules.signalboxcapture

import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.shadow.api.Shadow

@Implements(value = TileService::class, minSdk = Build.VERSION_CODES.N)
class RecordingTileServiceShadow {
  private var locked = false
  private var tile: Tile? = null

  var unlockCalls = 0
    private set
  var unlockRan = false
    private set
  var collapsedIntent: Intent? = null
    private set
  var collapsedPendingIntent: PendingIntent? = null
    private set

  @Implementation
  protected fun getQsTile(): Tile =
    tile ?: Shadow.newInstanceOf(Tile::class.java).also { tile = it }

  @Implementation
  protected fun isLocked(): Boolean = locked

  @Implementation
  protected fun unlockAndRun(runnable: Runnable) {
    unlockCalls += 1
    locked = false
    unlockRan = true
    runnable.run()
  }

  @Implementation
  protected fun startActivityAndCollapse(intent: Intent) {
    collapsedIntent = intent
  }

  @Implementation(minSdk = Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
  protected fun startActivityAndCollapse(pendingIntent: PendingIntent) {
    collapsedPendingIntent = pendingIntent
  }

  fun setLocked(locked: Boolean) {
    this.locked = locked
  }
}
