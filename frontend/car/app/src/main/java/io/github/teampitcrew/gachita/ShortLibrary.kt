package io.github.teampitcrew.gachita

import android.content.ContentUris
import android.content.Context
import android.graphics.Bitmap
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.provider.MediaStore.Video.Media as Videos
import android.util.Size

internal data class LibraryShort(val uri: Uri, val title: String, val durationMs: Long, val savedAt: Long)

/** 이 앱이 Movies/Gachita에 직접 저장한 영상만 읽습니다. 다른 앱의 사진 권한을 요청하지 않습니다. */
internal fun storedShorts(context: Context): List<LibraryShort> {
    return context.contentResolver.query(Videos.EXTERNAL_CONTENT_URI,
        arrayOf(Videos._ID, Videos.TITLE, Videos.DURATION, Videos.DATE_ADDED),
        "${Videos.RELATIVE_PATH}=? AND ${Videos.OWNER_PACKAGE_NAME}=? AND ${Videos.IS_PENDING}=0",
        arrayOf("Movies/Gachita/", context.packageName), "${Videos.DATE_ADDED} DESC")?.use { cursor ->
        buildList {
            while (cursor.moveToNext()) {
                val title = cursor.getString(1).orEmpty().takeUnless { it.isBlank() || it.startsWith("가치타_") } ?: "함께 남긴 대화"
                add(LibraryShort(ContentUris.withAppendedId(Videos.EXTERNAL_CONTENT_URI, cursor.getLong(0)), title, cursor.getLong(2), cursor.getLong(3) * 1000))
            }
        }
    }.orEmpty()
}

internal fun shortThumbnail(context: Context, uri: Uri): Bitmap? = runCatching {
    if (uri.scheme == "content") context.contentResolver.loadThumbnail(uri, Size(360, 640), null)
    else MediaMetadataRetriever().use { reader ->
        reader.setDataSource(context, uri)
        reader.getScaledFrameAtTime(1_000_000, MediaMetadataRetriever.OPTION_CLOSEST_SYNC, 360, 640)
    }
}.getOrNull()

internal fun shortDuration(ms: Long): String {
    val seconds = (ms / 1000).coerceAtLeast(0)
    return "%d:%02d".format(seconds / 60, seconds % 60)
}
