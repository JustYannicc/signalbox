package expo.modules.signalboxcapture

import android.content.Context

internal object CaptureTileState {
  private const val PREFERENCES = "signalbox-capture-tile"
  private const val ADDED = "added"

  fun isAdded(context: Context): Boolean =
    context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).getBoolean(ADDED, false)

  fun setAdded(context: Context, added: Boolean) {
    context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit().putBoolean(ADDED, added).apply()
  }
}
