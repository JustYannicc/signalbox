package expo.modules.signalboxcapture

import android.app.Activity
import android.app.StatusBarManager
import android.content.ComponentName
import android.os.Looper
import expo.modules.kotlin.Promise
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
@Config(sdk = [33], manifest = Config.NONE, shadows = [RecordingStatusBarManagerShadow::class])
class CaptureTileRequestTest {
  @Test
  fun addedAndAlreadyAddedCallbacksResolveAndPersistAddedState() {
    val context = RuntimeEnvironment.getApplication()
    val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
    val manager = activity.getSystemService(StatusBarManager::class.java)
    val statusBarShadow = Shadow.extract<RecordingStatusBarManagerShadow>(manager)

    for (result in listOf(
      StatusBarManager.TILE_ADD_REQUEST_RESULT_TILE_ADDED,
      StatusBarManager.TILE_ADD_REQUEST_RESULT_TILE_ALREADY_ADDED
    )) {
      CaptureTileState.setAdded(context, false)
      val promise = RecordingPromise()

      requestAddTile(activity, promise)
      shadowOf(Looper.getMainLooper()).idle()
      val request = requireNotNull(statusBarShadow.request)
      assertEquals(ComponentName(activity, CaptureTileService::class.java), request.component)
      assertEquals(context.getString(R.string.signalbox_capture_label), request.label)

      request.respond(result)
      shadowOf(Looper.getMainLooper()).idle()

      assertEquals("added", promise.resolved)
      assertEquals(1, promise.resolveCalls)
      assertNull(promise.rejection)
      assertTrue(CaptureTileState.isAdded(context))
    }
  }

  @Test
  fun notAddedCallbackResolvesCancelledWithoutChangingAddedState() {
    val context = RuntimeEnvironment.getApplication()
    val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
    CaptureTileState.setAdded(context, false)
    val promise = RecordingPromise()

    requestAddTile(activity, promise)
    shadowOf(Looper.getMainLooper()).idle()
    requireNotNull(Shadow.extract<RecordingStatusBarManagerShadow>(
      activity.getSystemService(StatusBarManager::class.java)
    ).request).respond(StatusBarManager.TILE_ADD_REQUEST_RESULT_TILE_NOT_ADDED)
    shadowOf(Looper.getMainLooper()).idle()

    assertEquals("cancelled", promise.resolved)
    assertEquals(1, promise.resolveCalls)
    assertNull(promise.rejection)
    assertFalse(CaptureTileState.isAdded(context))
  }

  @Test
  fun unknownCallbackRejectsAndLeavesAddedStateUntouched() {
    val context = RuntimeEnvironment.getApplication()
    val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
    CaptureTileState.setAdded(context, true)
    val promise = RecordingPromise()

    requestAddTile(activity, promise)
    shadowOf(Looper.getMainLooper()).idle()
    requireNotNull(Shadow.extract<RecordingStatusBarManagerShadow>(
      activity.getSystemService(StatusBarManager::class.java)
    ).request).respond(Int.MIN_VALUE)
    shadowOf(Looper.getMainLooper()).idle()

    assertNull(promise.resolved)
    assertEquals(1, promise.rejectCalls)
    assertEquals("CAPTURE_TILE_ADD_FAILED", promise.rejection?.code)
    assertEquals("Couldn't add Capture to Quick Settings. Try again.", promise.rejection?.message)
    assertNull(promise.rejection?.cause)
    assertTrue(CaptureTileState.isAdded(context))
  }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [32], manifest = Config.NONE)
class CaptureTileRequestUnsupportedTest {
  @Test
  fun apiBelowTiramisuResolvesUnsupportedBeforeCheckingForAnActivity() {
    val promise = RecordingPromise()

    requestAddTile(null, promise)

    assertEquals("unsupported", promise.resolved)
    assertEquals(1, promise.resolveCalls)
    assertNull(promise.rejection)
  }
}

private class RecordingPromise : Promise {
  var resolved: Any? = null
    private set
  var resolveCalls = 0
    private set
  var rejectCalls = 0
    private set
  var rejection: Rejection? = null
    private set

  override fun resolve(value: Any?) {
    resolveCalls += 1
    resolved = value
  }

  override fun reject(code: String?, message: String?, cause: Throwable?) {
    rejectCalls += 1
    rejection = Rejection(code, message, cause)
  }
}

private data class Rejection(val code: String?, val message: String?, val cause: Throwable?)
