package expo.modules.signalboxcapture

import android.app.PendingIntent
import android.content.ComponentName
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Bundle
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadow.api.Shadow

@RunWith(RobolectricTestRunner::class)
@Config(
  sdk = [24, 33, 34, 36],
  manifest = Config.NONE,
  shadows = [RecordingTileServiceShadow::class]
)
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

  @Test
  fun tileClickUsesTheApiAppropriateCollapseEntryPoint() {
    val context = RuntimeEnvironment.getApplication()
    installCaptureLaunchIntent(context.packageName)
    val service = Robolectric.buildService(CaptureTileService::class.java).create().get()

    service.onClick()

    val shadow = Shadow.extract<RecordingTileServiceShadow>(service)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      assertNull(shadow.collapsedIntent)
      val pendingIntent = requireNotNull(shadow.collapsedPendingIntent)
      val pendingIntentShadow = shadowOf(pendingIntent)
      assertEquals(
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        pendingIntentShadow.flags
      )
      assertCaptureIntent(pendingIntentShadow.savedIntent, context.packageName)
    } else {
      assertNull(shadow.collapsedPendingIntent)
      assertCaptureIntent(requireNotNull(shadow.collapsedIntent), context.packageName)
    }
  }

  @Test
  fun lockedTileClickOpensCaptureThroughUnlockAndRun() {
    val context = RuntimeEnvironment.getApplication()
    installCaptureLaunchIntent(context.packageName)
    val service = Robolectric.buildService(CaptureTileService::class.java).create().get()
    val shadow = Shadow.extract<RecordingTileServiceShadow>(service)
    shadow.setLocked(true)

    service.onClick()

    assertEquals(1, shadow.unlockCalls)
    assertTrue(shadow.unlockRan)
    assertTrue(shadow.collapsedIntent != null || shadow.collapsedPendingIntent != null)
  }

  private fun installCaptureLaunchIntent(packageName: String) {
    val packageManager = RuntimeEnvironment.getApplication().packageManager
    val shadowPackageManager = shadowOf(packageManager)
    val component = ComponentName(packageName, "$packageName.MainActivity")
    shadowPackageManager.addActivityIfNotPresent(component)
    shadowPackageManager.addIntentFilterForActivity(
      component,
      IntentFilter(Intent.ACTION_MAIN).apply { addCategory(Intent.CATEGORY_LAUNCHER) }
    )
    requireNotNull(shadowPackageManager.getInternalMutablePackageInfo(packageName).applicationInfo).metaData =
      Bundle().apply { putString(CaptureTileIntent.SCHEME_METADATA, "signalbox-test") }
  }

  private fun assertCaptureIntent(intent: Intent, packageName: String) {
    assertEquals(ComponentName(packageName, "$packageName.MainActivity"), intent.component)
    assertEquals(Intent.ACTION_VIEW, intent.action)
    assertEquals("signalbox-test://capture", intent.dataString)
    assertTrue(intent.flags and Intent.FLAG_ACTIVITY_NEW_TASK != 0)
    assertTrue(intent.flags and Intent.FLAG_ACTIVITY_SINGLE_TOP != 0)
  }
}
