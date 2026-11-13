package io.github.teampitcrew.gachita

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent

/** REQUESTED means startActivity returned without an error, not that two windows are visible. */
enum class NavigationLaunchResult(val message: String) {
    REQUESTED("내비 열기를 요청했어요. 창 위치는 차량 화면에서 바꿀 수 있어요"),
    UNAVAILABLE("기본 내비를 찾을 수 없어요"),
    DENIED("지금은 기본 내비를 열 수 없어요"),
    INACTIVE("가치타 화면으로 돌아온 뒤 다시 눌러 주세요"),
}

// Pleos Connect 2.1.0, 2026-11-14: `cmd package resolve-activity --brief -a
// android.intent.action.MAIN -c android.intent.category.LAUNCHER -p <package>` resolved
// ai.umos.maps.android.navigation.app/.MainActivity. Resolve its current launcher at runtime
// instead of depending on the Activity class name. <queries> makes this lookup visible on API 30+.
private const val PLEOS_NAVIGATION_PACKAGE = "ai.umos.maps.android.navigation.app"

/**
 * Call from a foreground user action. Pleos owns window placement; this requests an adjacent
 * window when the OS supports it and does not force which side either app occupies.
 * https://developer.android.com/reference/android/content/Intent#FLAG_ACTIVITY_LAUNCH_ADJACENT
 * https://document.pleos.ai/en/docs/connect/guide/docs-design/getting-started/window
 *
 * The launch may pause/stop this Activity. Do not finish it or restart it from onPause:
 * the existing foreground capture service and saved trip state own recording and restoration.
 * NEW_TASK is required for LAUNCH_ADJACENT; omitting MULTIPLE_TASK reuses the navigation task.
 */
fun requestNavigationAlongside(activity: Activity): NavigationLaunchResult {
    if (activity.isFinishing || activity.isDestroyed || !activity.hasWindowFocus()) {
        return NavigationLaunchResult.INACTIVE
    }
    return try {
        val intent = activity.packageManager.getLaunchIntentForPackage(PLEOS_NAVIGATION_PACKAGE)
            ?: return NavigationLaunchResult.UNAVAILABLE
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_LAUNCH_ADJACENT)
        activity.startActivity(intent)
        NavigationLaunchResult.REQUESTED
    } catch (_: ActivityNotFoundException) {
        NavigationLaunchResult.UNAVAILABLE
    } catch (_: SecurityException) {
        NavigationLaunchResult.DENIED
    }
}
