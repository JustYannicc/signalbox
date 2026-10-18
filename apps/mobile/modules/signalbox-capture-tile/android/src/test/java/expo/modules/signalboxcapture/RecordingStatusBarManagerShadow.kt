package expo.modules.signalboxcapture

import android.app.StatusBarManager
import android.content.ComponentName
import android.graphics.drawable.Icon
import android.os.Build
import java.util.concurrent.Executor
import java.util.function.Consumer
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements

@Implements(value = StatusBarManager::class, isInAndroidSdk = false)
class RecordingStatusBarManagerShadow {
  var request: TileAddRequest? = null
    private set

  @Implementation(minSdk = Build.VERSION_CODES.TIRAMISU)
  protected fun requestAddTileService(
    component: ComponentName,
    label: CharSequence,
    icon: Icon,
    executor: Executor,
    callback: Consumer<Int>
  ) {
    request = TileAddRequest(component, label, icon, executor, callback)
  }
}

data class TileAddRequest(
  val component: ComponentName,
  val label: CharSequence,
  val icon: Icon,
  private val executor: Executor,
  private val callback: Consumer<Int>
) {
  fun respond(result: Int) {
    executor.execute { callback.accept(result) }
  }
}
