package io.github.teampitcrew.gachita

import android.content.ClipData
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.media.MediaPlayer
import android.net.Uri
import android.os.Environment
import android.provider.MediaStore
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID

/*
 * '콘텐츠 기록' 탭(최종 시안 C33–C38, D27–D32, D補 emptyContent·player2·3·export2·3, 하단 작업 2026:3146).
 * 갤러리 | 타임라인 | 지도, 지도에서 고른 장면, 플레이어, 내보내기. 서버 값으로만 그린다(docs/api/places.md):
 * - 차는 프로필 토큰이 없어(계정 로그인은 흐름 F1) 지금 여행 하나를 GET /trips/{code}/contents(동의한 참가자 토큰)로 읽는다.
 * - 장소·경로·자막 줄은 녹음에 동의한 참가자에게만 온다. 없으면 그 칸을 비워 그리고 지어내지 않는다.
 * - 영상 파일은 그 여행의 참가자 토큰으로 받는다(전원 동의 규칙, short-assets.md). 내보내기는 MediaStore 저장 + 공유 시트.
 * 지도는 지도 제공자 없이 기록한 좌표를 상자에 투영한 도식 지도다(개편 계획 결정 5).
 */

internal data class ContentPerson(val id: String, val name: String, val character: String, val seat: String? = null)
internal data class ContentLine(val at: Long, val participantId: String?, val name: String?, val text: String)
internal data class ContentPlace(val kind: String, val name: String, val at: Long)
internal data class ContentItem(val id: String, val title: String, val seconds: Double, val at: Long, val from: Long?, val lat: Double?, val lng: Double?,
    val place: String?, val kind: String, val cast: List<ContentPerson>, val lines: List<ContentLine>, val url: String)
internal data class ContentTrip(val code: String, val title: String, val createdAt: Long, val members: List<ContentPerson>, val places: List<ContentPlace>,
    val route: List<Pair<Double, Double>>, val contents: List<ContentItem>)

private fun JSONObject.str(key: String): String? = if (isNull(key) || !has(key)) null else optString(key)
private fun JSONObject.num(key: String): Double? = if (isNull(key) || !has(key)) null else optDouble(key).takeIf { !it.isNaN() }
private fun <T> JSONArray?.list(f: (JSONObject) -> T): List<T> = if (this == null) emptyList() else (0 until length()).map { f(getJSONObject(it)) }

/** GET /trips/{code}/contents·/profiles/me/trips 항목 하나. 새 칸(cast·lines·from)이 없는 옛 서버여도 읽는다. */
internal fun parseContentTrip(json: JSONObject): ContentTrip {
    val members = json.optJSONArray("members").list { ContentPerson(it.getString("participantId"), it.optString("name"), it.optString("character"), it.str("seat")) }
    val seat = members.associate { it.id to it.seat }
    val route = json.optJSONArray("route")?.let { a -> (0 until a.length()).map { a.getJSONArray(it).let { p -> p.getDouble(0) to p.getDouble(1) } } }.orEmpty()
    return ContentTrip(json.getString("code"), json.optString("title"), json.optLong("createdAt"), members,
        json.optJSONArray("places").list { ContentPlace(it.optString("kind"), it.optString("name"), it.optLong("at")) }.filter { it.name.isNotBlank() }.sortedBy { it.at },
        route,
        json.optJSONArray("contents").list { c ->
            ContentItem(c.getString("id"), c.optString("title"), c.optDouble("seconds", 0.0), c.getLong("at"), c.num("from")?.toLong(), c.num("lat"), c.num("lng"),
                c.str("place"), c.optString("kind"),
                c.optJSONArray("cast").list { ContentPerson(it.getString("participantId"), it.optString("name"), it.optString("character"), seat[it.getString("participantId")]) },
                c.optJSONArray("lines").list { ContentLine(it.getLong("at"), it.str("participantId"), it.str("name"), it.optString("text")) },
                c.getString("url"))
        }.sortedBy { it.at })
}

private fun hhmm(at: Long) = SimpleDateFormat("HH:mm", Locale.KOREA).format(Date(at))
internal fun monthDay(at: Long) = SimpleDateFormat("M월 d일", Locale.KOREA).format(Date(at))
internal fun contentClock(seconds: Double) = "%02d:%02d".format((seconds / 60).toInt(), (seconds % 60).toInt())

/** 타임라인 머리 '09:20 출발 → 하나로마트 → 10:28 숙소'. 장소가 없으면(동의 전) 빈 글. */
internal fun contentTripLine(places: List<ContentPlace>): String {
    val start = places.firstOrNull { it.kind == "start" }
    val stops = places.filter { it.kind == "arrived" || it.kind == "stop" }
    val names = stops.map { it.name.trim() }.distinct()
    val parts = mutableListOf<String>()
    if (start != null) parts += "${hhmm(start.at)} 출발"
    names.forEachIndexed { i, n -> parts += if (i == names.lastIndex) "${hhmm(stops.last().at)} $n" else n }
    return parts.joinToString(" → ")
}

/** 지도 아래 '동해고속도로 → 하나로마트 → 강릉 숙소': 출발·곧 도착을 뺀 장소 이름을 처음 나온 순서로. */
internal fun contentPlaceChain(places: List<ContentPlace>) = places.filter { it.kind != "start" && it.kind != "approaching" }.map { it.name.trim() }.distinct().joinToString(" → ")

internal fun contentPinLabel(title: String) = title.trim().let { if (it.length > 10) it.take(9) + "…" else it }

// mock: 서버에 장면 머리글(시안 '바다를 찾는 아빠와 이미 찾은 서준')의 원천이 없다. 말한 사람 이름으로 만든 글(#392 플랜 표 '목업').
internal fun contentHeadline(item: ContentItem): String {
    val names = item.cast.map { it.name }.filter { it.isNotBlank() }
    fun wa(w: String): String { val c = w.last().code - 0xAC00; return if (c in 0 until 11172 && c % 28 != 0) "${w}과" else "${w}와" }
    return when { names.size >= 2 -> "${wa(names[0])}\n${names[1]}의 이야기"; names.size == 1 -> "${names[0]}의 이야기"; else -> item.title.ifBlank { "우리 가족의 장면" } }
}

// mock: 서버에 영상 형식 이름이 없다. 기기에서 만든 기본 영상은 캐릭터 자막형, 생성한 영상은 가족 대화형(시안 C32의 두 이름).
internal fun contentStyle(item: ContentItem) = if (item.kind == "generated") "가족 대화형" else "캐릭터 자막형"

/** 재생 위치(초)의 자막 줄: 장면 구간 시작(from)부터 지난 시간 전에 시작한 마지막 줄. 없으면 첫 줄. */
internal fun contentLineAt(item: ContentItem, seconds: Double): ContentLine? {
    if (item.lines.isEmpty()) return null
    val from = item.from ?: item.lines.first().at
    return item.lines.lastOrNull { (it.at - from) / 1000.0 <= seconds } ?: item.lines.first()
}

/** 좌표를 w×h 상자에 투영(위가 북쪽, 여백 pad). 도식 지도라 가로·세로를 따로 늘려 채운다(한쪽 3배까지). 좌표가 없으면 null. */
internal fun contentProjector(points: List<Pair<Double, Double>>, w: Float, h: Float, pad: Float): ((Pair<Double, Double>) -> Offset)? {
    if (points.isEmpty()) return null
    val minLat = points.minOf { it.first }; val maxLat = points.maxOf { it.first }
    val minLng = points.minOf { it.second }; val maxLng = points.maxOf { it.second }
    val kx = Math.cos((minLat + maxLat) / 2 * Math.PI / 180)
    val spanX = maxOf((maxLng - minLng) * kx, 1e-6); val spanY = maxOf(maxLat - minLat, 1e-6)
    val base = minOf((w - 2 * pad) / spanX, (h - 2 * pad) / spanY)
    val sx = minOf((w - 2 * pad) / spanX, base * 3); val sy = minOf((h - 2 * pad) / spanY, base * 3)
    val ox = (w - spanX * sx) / 2; val oy = (h - spanY * sy) / 2
    return { (lat, lng) -> Offset((ox + (lng - minLng) * kx * sx).toFloat(), (oy + (maxLat - lat) * sy).toFloat()) }
}

private enum class ContentsPage { GALLERY, TIMELINE, MAP, DETAIL, PLAYER, EXPORT }
private val Shape = RoundedCornerShape(24.dp)
private val TONES_DARK = listOf(Color(0xFF3A3122), Color(0xFF3C2834))
private val TONES_LIGHT = listOf(Color(0xFFFDF0DC), Color(0xFFFBE5EE))
private val SEAT_ORDER = listOf("ROW_1_LEFT", "ROW_1_RIGHT", "ROW_2_LEFT", "ROW_2_CENTER", "ROW_2_RIGHT")
private val SEAT_FALLBACK = listOf(R.drawable.char_basic, R.drawable.char_cap, R.drawable.char_glasses, R.drawable.char_travel, R.drawable.char_game)
private fun characterOf(p: ContentPerson?): Int = ShortCharacter.entries.firstOrNull { it.key == p?.character }?.drawable
    ?: SEAT_FALLBACK[SEAT_ORDER.indexOf(p?.seat).coerceAtLeast(0)]

@Composable
private fun Face(p: ContentPerson?, size: androidx.compose.ui.unit.Dp) {
    Image(painterResource(characterOf(p)), null, Modifier.size(size).clip(RoundedCornerShape(size / 4)).background(Color(0xFFFFFFFF)), contentScale = ContentScale.Fit)
}

@Composable
private fun BottomButton(label: String, primary: Boolean, modifier: Modifier, onClick: () -> Unit) {
    val c = MaterialTheme.colorScheme
    Surface(onClick = onClick, modifier = modifier.height(96.dp), shape = Shape, color = if (primary) c.primary else c.surfaceVariant) {
        Box(contentAlignment = Alignment.Center) { Text(label, fontSize = 30.sp, fontWeight = FontWeight.Bold, color = if (primary) c.onPrimary else c.onSurface) }
    }
}

/** 콘텐츠 기록 탭 전체. token은 지금 여행에서 녹음에 동의한 이 차의 참가자 토큰(없으면 빈 상태). */
@Composable
internal fun ContentsRecord(base: String, code: String, token: String?, canRead: () -> Boolean, canPlay: () -> Boolean,
    onRide: () -> Unit, onStudio: () -> Unit, onActiveChange: (Boolean) -> Unit, members: Int, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val c = MaterialTheme.colorScheme
    val dark = c.background.red < 0.5f
    val tones = if (dark) TONES_DARK else TONES_LIGHT
    val read by rememberUpdatedState(canRead)
    val play by rememberUpdatedState(canPlay)
    val scope = rememberCoroutineScope()
    val api = remember(base) { Server(base) }
    var trip by remember { mutableStateOf<ContentTrip?>(null) }
    var loaded by remember { mutableStateOf(false) }
    var note by remember { mutableStateOf("") }
    var page by remember { mutableStateOf(ContentsPage.GALLERY) }
    var pin by remember { mutableStateOf<String?>(null) }
    var selected by remember { mutableStateOf<String?>(null) }
    var file by remember { mutableStateOf<Pair<String, File>?>(null) }
    var player by remember { mutableStateOf<MediaPlayer?>(null) }
    var playing by remember { mutableStateOf(false) }
    var position by remember { mutableStateOf(0.0) }
    var busy by remember { mutableStateOf(false) }
    var saved by remember { mutableStateOf<Uri?>(null) }

    fun stop() { runCatching { player?.release() }; player = null; playing = false; position = 0.0 }
    DisposableEffect(Unit) {
        onActiveChange(true); CaptureService.hold(true)
        onDispose { stop(); file?.second?.delete(); CaptureService.hold(false); onActiveChange(false) }
    }
    LaunchedEffect(code, token) {
        loaded = false; note = ""
        if (token == null || !read()) { trip = null; loaded = true; return@LaunchedEffect }
        try { trip = withContext(Dispatchers.IO) { parseContentTrip(JSONObject(api.contents(code, token))) } }
        catch (e: Exception) { trip = null; note = if (e is ApiError && e.status == 403) "기록에 동의한 사람만 콘텐츠 기록을 볼 수 있어요" else e.message ?: "연결을 확인해 주세요" }
        loaded = true
    }
    LaunchedEffect(playing) { while (playing) { position = (player?.currentPosition ?: 0) / 1000.0; delay(250) } }
    LaunchedEffect(play()) { if (!play()) stop() }

    val items = trip?.contents.orEmpty()
    val item = items.firstOrNull { it.id == selected }

    suspend fun fetch(it: ContentItem): File {
        file?.takeIf { f -> f.first == it.id }?.let { return it.second }
        val t = requireNotNull(token) { "기록 동의와 연결을 확인해 주세요" }
        check(read()) { "모두의 기록 동의와 연결을 확인해 주세요" }
        val f = withContext(Dispatchers.IO) {
            File.createTempFile("content-", ".mp4", context.cacheDir).also { f ->
                api.downloadShort(base.trimEnd('/') + it.url, t, f, { !play() }, {}, maxBytes = SHARED_SHORT_MAX_BYTES)
            }
        }
        file?.second?.delete(); file = it.id to f
        return f
    }
    fun open(id: String) { if (selected != id) { stop(); saved = null }; selected = id; page = ContentsPage.PLAYER; note = "" }
    fun toggle() {
        val it = item ?: return
        if (busy) return
        player?.let { p -> if (p.isPlaying) { p.pause(); playing = false } else { p.start(); playing = true }; return }
        busy = true
        scope.launch {
            try {
                val f = fetch(it)
                val p = withContext(Dispatchers.IO) { MediaPlayer().apply { setDataSource(f.path); prepare() } }
                if (!play()) { p.release(); return@launch }
                p.setOnCompletionListener { playing = false }
                player = p; p.start(); playing = true
            } catch (e: Exception) { note = if (e is ApiError) "영상을 불러오지 못했어요. 기록 동의와 연결을 확인해 주세요" else e.message ?: "영상을 불러오지 못했어요" }
            finally { busy = false }
        }
    }
    fun export() {
        val it = item ?: return
        if (busy) return
        busy = true; note = ""
        scope.launch {
            try {
                val uri = saved ?: run {
                    val f = fetch(it)
                    withContext(Dispatchers.IO) {
                        val resolver = context.contentResolver
                        val target = requireNotNull(resolver.insert(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, ContentValues().apply {
                            put(MediaStore.Video.Media.DISPLAY_NAME, "가치타_${UUID.randomUUID()}.mp4"); put(MediaStore.Video.Media.TITLE, it.title)
                            put(MediaStore.Video.Media.MIME_TYPE, "video/mp4"); put(MediaStore.Video.Media.RELATIVE_PATH, "${Environment.DIRECTORY_MOVIES}/Gachita"); put(MediaStore.Video.Media.IS_PENDING, 1)
                        }))
                        try {
                            requireNotNull(resolver.openOutputStream(target)).use { out -> f.inputStream().use { input -> input.copyTo(out) } }
                            check(resolver.update(target, ContentValues().apply { put(MediaStore.Video.Media.IS_PENDING, 0) }, null, null) == 1)
                            target
                        } catch (e: Exception) { resolver.delete(target, null, null); throw e }
                    }
                }
                saved = uri; note = "기기 갤러리(Movies/Gachita)에 저장했어요"
                context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).apply {
                    type = "video/mp4"; putExtra(Intent.EXTRA_STREAM, uri); clipData = ClipData.newRawUri("가치타 영상", uri); addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }, "영상 공유").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            } catch (e: Exception) { note = if (e is ApiError) "영상을 받지 못했어요. 기록 동의와 연결을 확인해 주세요" else e.message ?: "저장하지 못했어요" }
            finally { busy = false }
        }
    }

    Column(modifier, verticalArrangement = Arrangement.spacedBy(16.dp)) {
        val empty = loaded && items.isEmpty()
        val (title, sub) = when {
            page == ContentsPage.PLAYER && item != null -> item.title to listOfNotNull("${monthDay(item.at)} ${hhmm(item.at)}", item.place).joinToString(" / ")
            page == ContentsPage.EXPORT && item != null -> "공유할 준비가 됐어요" to "캐릭터와 우리 목소리가 담긴 짧은 영상"
            page == ContentsPage.DETAIL -> "이 길에서 나눈 이야기" to "지도에서 선택한 우리 가족의 장면"
            page == ContentsPage.TIMELINE && !empty -> "콘텐츠 기록" to "날짜를 따라 다시 보는 우리 가족"
            page == ContentsPage.MAP && !empty -> "콘텐츠 기록" to "어디에서 나눈 이야기였을까요?"
            else -> "콘텐츠 기록" to "우리 가족 / 차량과 폰에서 이어보기"
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(title, fontSize = 36.sp, fontWeight = FontWeight.Bold, color = c.onBackground, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(sub, fontSize = 22.sp, color = c.onSurfaceVariant)
            }
            if (page in listOf(ContentsPage.GALLERY, ContentsPage.TIMELINE, ContentsPage.MAP)) TextButton(onClick = { stop(); onStudio() }) { Text("쇼츠 만들기·보관함", fontSize = 22.sp, color = c.onSurfaceVariant) }
        }
        Box(Modifier.weight(1f).fillMaxWidth()) {
            when {
                !loaded -> Text("콘텐츠 기록을 불러오고 있어요", fontSize = 26.sp, color = c.onSurfaceVariant)
                empty -> Text(if (note.isNotBlank()) note else "아직 생성한 콘텐츠가 없어요.\n여행을 마친 뒤 대화에서 장면을 골라 보세요.", fontSize = 30.sp, lineHeight = 40.sp, fontWeight = FontWeight.Bold, color = c.onSurfaceVariant)
                page == ContentsPage.PLAYER && item != null -> PlayerCard(item, position, playing, busy, note, Modifier.fillMaxWidth(0.42f), ::toggle)
                page == ContentsPage.EXPORT && item != null -> Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                    Column(Modifier.weight(1.6f), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                        Surface(shape = Shape, color = c.primaryContainer, modifier = Modifier.fillMaxWidth()) {
                            Row(Modifier.padding(20.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(18.dp)) {
                                Face(item.cast.getOrNull(1) ?: item.cast.firstOrNull(), 64.dp)
                                Column { Text("${contentStyle(item)} / 9:16", fontSize = 28.sp, fontWeight = FontWeight.Bold, color = c.onSurface)
                                    Text("MP4 / 세로 영상 ${item.seconds.toInt()}초", fontSize = 22.sp, color = c.onSurfaceVariant) }
                            }
                        }
                        Surface(onClick = ::export, enabled = !busy, shape = Shape, color = c.surface, modifier = Modifier.fillMaxWidth()) {
                            Column(Modifier.padding(horizontal = 20.dp, vertical = 22.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                Text("내 계정으로 폰에 저장", fontSize = 28.sp, fontWeight = FontWeight.Bold, color = c.onSurface)
                                Text(if (busy) "영상을 받고 있어요" else if (saved != null) "저장했어요. 공유할 앱을 골라 주세요" else "콘텐츠 기록에서 같은 영상을 바로 확인", fontSize = 22.sp, color = c.onSurfaceVariant)
                            }
                        }
                        if (note.isNotBlank()) Text(note, fontSize = 22.sp, color = c.onSurfaceVariant)
                    }
                    FamilyCard(trip?.members.orEmpty(), members, Modifier.weight(1f).fillMaxHeight())
                }
                page == ContentsPage.DETAIL -> Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    MapCard(trip!!, pin, tones, Modifier.fillMaxWidth().weight(1f)) { pin = it }
                    val picked = items.firstOrNull { it.id == pin } ?: items.firstOrNull { it.lat != null } ?: items.first()
                    items.filter { it.place == picked.place }.take(2).forEach { x ->
                        Surface(onClick = { open(x.id) }, shape = Shape, color = c.primaryContainer, modifier = Modifier.fillMaxWidth()) {
                            Row(Modifier.padding(18.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(18.dp)) {
                                Face(x.cast.getOrNull(1) ?: x.cast.firstOrNull(), 60.dp)
                                Column { Text(listOfNotNull(hhmm(x.at), x.place).joinToString(" / "), fontSize = 28.sp, fontWeight = FontWeight.Bold, color = c.onSurface)
                                    Text("${x.title} / ${x.seconds.toInt()}초", fontSize = 22.sp, color = c.onSurfaceVariant) }
                            }
                        }
                    }
                }
                else -> Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        listOf(ContentsPage.GALLERY to "갤러리", ContentsPage.TIMELINE to "타임라인", ContentsPage.MAP to "지도").forEach { (p, label) ->
                            Surface(onClick = { page = p }, modifier = Modifier.weight(1f).height(84.dp), shape = Shape, color = if (page == p) c.primary else c.surfaceVariant) {
                                Box(contentAlignment = Alignment.Center) { Text(label, fontSize = 30.sp, fontWeight = FontWeight.Bold, color = if (page == p) c.onPrimary else c.onSurface) }
                            }
                        }
                    }
                    val t = trip!!
                    val heading = "${monthDay(items.first().at)}  ${t.title.ifBlank { "함께 탄 여행" }}"
                    when (page) {
                        ContentsPage.TIMELINE -> Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                            Surface(shape = Shape, color = c.primaryContainer, modifier = Modifier.fillMaxWidth()) {
                                Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                    Text(heading, fontSize = 28.sp, fontWeight = FontWeight.Bold, color = c.onSurface)
                                    contentTripLine(t.places).takeIf { it.isNotBlank() }?.let { Text(it, fontSize = 22.sp, color = c.onSurfaceVariant) }
                                }
                            }
                            items.forEach { x ->
                                Surface(onClick = { open(x.id) }, shape = Shape, color = c.surface, modifier = Modifier.fillMaxWidth()) {
                                    Row(Modifier.padding(18.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(18.dp)) {
                                        Face(x.cast.getOrNull(1) ?: x.cast.firstOrNull(), 60.dp)
                                        Column { Text("${hhmm(x.at)}  ${x.title}", fontSize = 28.sp, fontWeight = FontWeight.Bold, color = c.onSurface, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                            Text(listOfNotNull("${x.seconds.toInt()}초", x.place).joinToString(" / "), fontSize = 22.sp, color = c.onSurfaceVariant) }
                                    }
                                }
                            }
                        }
                        ContentsPage.MAP -> MapCard(t, pin, tones, Modifier.fillMaxWidth().weight(1f)) { pin = it }
                        else -> Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                            Text(heading, fontSize = 28.sp, fontWeight = FontWeight.Bold, color = c.onBackground)
                            items.chunked(2).forEach { row ->
                                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                                    row.forEach { x ->
                                        Surface(onClick = { open(x.id) }, shape = Shape, color = tones[items.indexOf(x) % 2], modifier = Modifier.weight(1f).height(214.dp)) {
                                            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                                                Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) { x.cast.take(2).forEach { Face(it, 86.dp) } }
                                                Text(x.title, fontSize = 26.sp, fontWeight = FontWeight.Bold, color = c.onSurface, maxLines = 2, overflow = TextOverflow.Ellipsis)
                                                Text("${x.seconds.toInt()}초 / ${hhmm(x.at)}", fontSize = 20.sp, color = c.onSurfaceVariant)
                                            }
                                        }
                                    }
                                    if (row.size == 1) Spacer(Modifier.weight(1f))
                                }
                            }
                        }
                    }
                }
            }
        }
        // 하단 작업. 플레이어는 2026:3146('콘텐츠 기록' 보조 + '영상 내보내기' 주).
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            val empty = loaded && items.isEmpty()
            when {
                empty || !loaded -> BottomButton("함께 타는 중으로", true, Modifier.weight(1f), onRide)
                page == ContentsPage.PLAYER -> { BottomButton("콘텐츠 기록", false, Modifier.weight(0.3f)) { stop(); page = ContentsPage.GALLERY }; BottomButton("영상 내보내기", true, Modifier.weight(0.7f)) { player?.pause(); playing = false; page = ContentsPage.EXPORT } }
                page == ContentsPage.EXPORT -> BottomButton("콘텐츠 기록으로", true, Modifier.weight(1f)) { stop(); page = ContentsPage.GALLERY }
                page == ContentsPage.DETAIL -> { BottomButton("지도로 돌아가기", false, Modifier.weight(0.3f)) { page = ContentsPage.MAP }
                    BottomButton("이 장면 보기", true, Modifier.weight(0.7f)) { (items.firstOrNull { it.id == pin } ?: items.firstOrNull { it.lat != null } ?: items.first()).let { open(it.id) } } }
                page == ContentsPage.TIMELINE -> BottomButton("지도에서 보기", true, Modifier.weight(1f)) { page = ContentsPage.MAP }
                page == ContentsPage.MAP -> BottomButton("장면 확대하기", true, Modifier.weight(1f)) { page = ContentsPage.DETAIL }
                else -> BottomButton("우리 가족 프로필", true, Modifier.weight(1f), onRide)
            }
        }
    }
}

@Composable
private fun PlayerCard(item: ContentItem, position: Double, playing: Boolean, busy: Boolean, note: String, modifier: Modifier, onToggle: () -> Unit) {
    val c = MaterialTheme.colorScheme
    val said = contentLineAt(item, position)
    Surface(shape = Shape, color = c.surface, modifier = modifier) {
        Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
            Text(contentHeadline(item), fontSize = 32.sp, lineHeight = 40.sp, fontWeight = FontWeight.Bold, color = c.onSurface)
            Row(horizontalArrangement = Arrangement.spacedBy(36.dp)) { item.cast.take(2).forEach { Face(it, 136.dp) } }
            said?.let { Text(listOfNotNull(it.name, "“${it.text}”").joinToString("  "), fontSize = 26.sp, fontWeight = FontWeight.Bold, color = c.onSurface) }
            Text("${if (playing) "❚❚" else "▶"}  ${contentClock(position)} / ${contentClock(item.seconds)}", fontSize = 22.sp, color = c.onSurfaceVariant,
                modifier = Modifier.clickable(enabled = !busy, onClick = onToggle).padding(vertical = 6.dp))
            if (busy) Text("영상을 받고 있어요", fontSize = 20.sp, color = c.onSurfaceVariant)
            if (note.isNotBlank()) Text(note, fontSize = 20.sp, color = c.onSurfaceVariant)
        }
    }
}

/** 시안 C38 오른쪽 '차가 바뀌어도 우리는 그대로' 카드. 구성원은 지금 여행의 참가자. */
@Composable
private fun FamilyCard(people: List<ContentPerson>, count: Int, modifier: Modifier) {
    val c = MaterialTheme.colorScheme
    Surface(shape = Shape, color = c.surface, modifier = modifier) {
        Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Text("차가 바뀌어도\n우리는 그대로", fontSize = 30.sp, lineHeight = 38.sp, fontWeight = FontWeight.Bold, color = c.onSurface)
            Text("한 번 만든 가족 프로필로\n차량과 폰에서 이어가세요.", fontSize = 22.sp, color = c.onSurfaceVariant)
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) { people.take(4).forEach { Face(it, 72.dp) } }
            Text("우리 가족  ${maxOf(count, people.size)}명", fontSize = 26.sp, fontWeight = FontWeight.Bold, color = c.onSurface)
            Text("프로필과 목소리, 가족 그룹을\n같은 계정으로 함께 사용", fontSize = 20.sp, color = c.onSurfaceVariant)
        }
    }
}

/** 도식 지도: 배경 무늬(도로·바다, 실제 지형 아님) + 기록한 경로(초록) + 콘텐츠 위치의 캐릭터 핀 + 장소 줄. */
@Composable
private fun MapCard(trip: ContentTrip, pin: String?, tones: List<Color>, modifier: Modifier, onPin: (String) -> Unit) {
    val c = MaterialTheme.colorScheme
    val dark = c.background.red < 0.5f
    val land = if (dark) Color(0xFF26231F) else Color(0xFFEFEBE5)
    val road = if (dark) Color(0xFFC9C0B2) else Color(0xFFB8B0A3)
    val water = if (dark) Color(0xFF5C7A80) else Color(0xFFB7D3D8)
    Surface(shape = Shape, color = c.surface, modifier = modifier) {
        Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            BoxWithConstraints(Modifier.fillMaxWidth().weight(1f).clip(RoundedCornerShape(16.dp)).background(land)) {
                val density = LocalDensity.current
                val w = with(density) { maxWidth.toPx() }; val h = with(density) { maxHeight.toPx() }
                val top = with(density) { 110.dp.toPx() }
                val pins = trip.contents.filter { it.lat != null && it.lng != null }
                val fit = contentProjector(trip.route + pins.map { it.lat!! to it.lng!! }, w, h - top, with(density) { 40.dp.toPx() })
                val project: ((Pair<Double, Double>) -> Offset)? = fit?.let { f -> { p -> f(p).let { o -> Offset(o.x, o.y + top) } } }
                Canvas(Modifier.fillMaxSize()) {
                    val stroke = Stroke(4f)
                    drawLine(road, Offset(w * 0.15f, h * 0.8f), Offset(w * 0.85f, h * 0.45f), 4f)
                    drawLine(road, Offset(w * 0.26f, 0f), Offset(w * 0.42f, h), 4f)
                    drawLine(road, Offset(w * 0.5f, 0f), Offset(w * 0.62f, h), 4f)
                    drawPath(Path().apply { moveTo(w * 0.78f, 0f); cubicTo(w * 0.74f, h * 0.3f, w * 0.86f, h * 0.6f, w * 0.8f, h); lineTo(w, h); lineTo(w, 0f); close() }, water)
                    if (project != null && trip.route.size > 1) drawPath(Path().apply {
                        trip.route.forEachIndexed { i, p -> val o = project(p); if (i == 0) moveTo(o.x, o.y) else lineTo(o.x, o.y) }
                    }, Color(0xFF6FD3A6), style = Stroke(14f, cap = StrokeCap.Round, join = StrokeJoin.Round))
                    if (project != null) pins.forEach { drawCircle(Color(0xFF6FD3A6), 12f, project(it.lat!! to it.lng!!)); drawCircle(land, 12f, project(it.lat to it.lng), style = stroke) }
                }
                if (project == null) Text("기록한 위치가 없어 길을 그리지 못했어요.", fontSize = 20.sp, color = c.onSurfaceVariant, modifier = Modifier.align(Alignment.BottomStart).padding(16.dp))
                project?.let { pr -> pins.forEachIndexed { i, x ->
                    val o = pr(x.lat!! to x.lng!!)
                    val pinW = 200.dp; val pinH = 100.dp
                    val dx = with(density) { (o.x - pinW.toPx() / 2).toDp() }; val dy = with(density) { (o.y - pinH.toPx() - 14.dp.toPx()).toDp() }
                    Surface(onClick = { onPin(x.id) }, shape = RoundedCornerShape(18.dp), color = tones[i % 2],
                        border = if (pin == x.id) androidx.compose.foundation.BorderStroke(3.dp, Color(0xFF6FD3A6)) else null,
                        modifier = Modifier.offset(dx.coerceAtLeast(0.dp), dy.coerceAtLeast(0.dp)).size(pinW, pinH)) {
                        Column(Modifier.padding(10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Face(x.cast.getOrNull(1) ?: x.cast.firstOrNull(), 48.dp)
                            Text(contentPinLabel(x.title), fontSize = 20.sp, color = c.onSurface, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                } }
            }
            contentPlaceChain(trip.places).takeIf { it.isNotBlank() }?.let { Text(it, fontSize = 20.sp, color = c.onSurfaceVariant) }
        }
    }
}
