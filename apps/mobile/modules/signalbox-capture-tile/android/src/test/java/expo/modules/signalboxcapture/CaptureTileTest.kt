package expo.modules.signalboxcapture

import android.content.ComponentName
import android.content.Intent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [24, 34, 36], manifest = Config.NONE)
class CaptureTileTest {
  @Test
  fun captureOpensTheOwningBuildWithoutReplacingItsNavigation() {
    val component = ComponentName("com.signalbox.test", "com.signalbox.test.MainActivity")
    val launch = Intent(Intent.ACTION_MAIN).setComponent(component)
    for (scheme in listOf("signalbox", "signalbox-dev", "signalbox-preview")) {
      val capture = CaptureTileIntent.forCapture(launch, scheme)
      assertEquals(component, capture.component)
      assertEquals(Intent.ACTION_VIEW, capture.action)
      assertEquals("$scheme://capture", capture.dataString)
      assertTrue(capture.flags and Intent.FLAG_ACTIVITY_NEW_TASK != 0)
      assertTrue(capture.flags and Intent.FLAG_ACTIVITY_SINGLE_TOP != 0)
      assertFalse(capture.flags and Intent.FLAG_ACTIVITY_CLEAR_TASK != 0)
    }
    assertEquals(Intent.ACTION_MAIN, launch.action)
    assertEquals(null, launch.data)
  }

  @Test
  fun tileLifecycleKeepsTheSettingsStateCurrent() {
    val context = RuntimeEnvironment.getApplication()
    CaptureTileState.setAdded(context, false)
    val service = Robolectric.buildService(CaptureTileService::class.java).create().get()
    assertFalse(CaptureTileState.isAdded(context))

    service.onTileAdded()
    assertTrue(CaptureTileState.isAdded(context))

    service.onTileRemoved()
    assertFalse(CaptureTileState.isAdded(context))
  }
}
