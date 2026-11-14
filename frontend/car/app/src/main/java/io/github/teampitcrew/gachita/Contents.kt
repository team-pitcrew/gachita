package io.github.teampitcrew.gachita

import android.content.ClipData
import android.content.ContentValues
import android.content.Intent
import android.media.MediaPlayer
import android.net.Uri
import android.os.Environment
import android.provider.MediaStore
import androidx.compose.foundation.BorderStroke
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
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
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
 * '콘텐츠 기록' 탭 본문(원본 Figma Y7zFqGUEAFDWTumG30MsOs '민준 개선안' 2004:57의 현재 판: C33 갤러리 2005:4482, C34 타임라인 2005:4522,
 * C35 지도 2005:4562, C36 상세 2005:4601, C37 플레이어 2005:4640(재생 중 2081:4294·일시정지 2083:4309), C38 내보내기 2005:4668,
 * D27–D32, D補 emptyContent 2026:2473·player2/3·export2/3, 하단 작업 2026:3146). 머리 줄과 위 탭은 MainActivity가 Shell.PARKED로 그린다.
 * 서버 값으로만 그린다(docs/api/places.md):
 * - 차는 프로필 토큰이 없어(계정 로그인은 흐름 F1) 지금 여행 하나를 GET /trips/{code}/contents(동의한 참가자 토큰)로 읽는다.
 * - 장소·경로·자막 줄은 녹음에 동의한 참가자에게만 온다. 없으면 그 칸을 비워 그리고 지어내지 않는다.
 * - 영상 파일은 그 여행의 참가자 토큰으로 받는다(전원 동의 규칙, short-assets.md). 내보내기는 MediaStore 저장 + 공유 시트.
 * 지도는 번들 OpenStreetMap 그림(시안 'Asset / 강릉 실제 지도 / OpenStreetMap' 2067:3071, 실행 중 타일 서버를 부르지 않음) 위에 기록한 좌표를 투영한다.
 * 좌표가 그 그림 밖이면 지도 제공자 없이 상자에 투영한 도식 지도다(개편 계획 결정 5).
 */

internal data class ContentPerson(val id: String, val name: String, val character: String, val seat: String? = null)
internal data class ContentLine(val at: Long, val participantId: String?, val name: String?, val text: String)
internal data class ContentPlace(val kind: String, val name: String, val at: Long)
internal data class ContentItem(val id: String, val title: String, val seconds: Double, val at: Long, val from: Long?, val lat: Double?, val lng: Double?,
    val place: String?, val kind: String, val cast: List<ContentPerson>, val lines: List<ContentLine>, val url: String)
internal data class ContentTrip(val code: String, val title: String, val createdAt: Long, val members: List<ContentPerson>, val places: List<ContentPlace>,
    val route: List<Pair<Double, Double>>, val contents: List<ContentItem>, val startedAt: Long? = null, val endedAt: Long? = null)

private fun JSONObject.str(key: String): String? = if (isNull(key) || !has(key)) null else optString(key)
private fun JSONObject.num(key: String): Double? = if (isNull(key) || !has(key)) null else optDouble(key).takeIf { !it.isNaN() }
private fun <T> JSONArray?.list(f: (JSONObject) -> T): List<T> = if (this == null) emptyList() else (0 until length()).map { f(getJSONObject(it)) }

/** GET /trips/{code}/contents·/profiles/me/trips 항목 하나. 새 칸(cast·lines·from·startedAt·endedAt)이 없는 옛 서버여도 읽는다. */
internal fun parseContentTrip(json: JSONObject): ContentTrip {
    val members = json.optJSONArray("members").list { ContentPerson(it.getString("participantId"), it.optString("name"), it.optString("character"), it.str("seat")) }
    val seat = members.associate { it.id to it.seat }
    val route = json.optJSONArray("route")?.let { a -> (0 until a.length()).map { a.getJSONArray(it).let { p -> p.getDouble(0) to p.getDouble(1) } } }.orEmpty()
    val places = json.optJSONArray("places").list { ContentPlace(it.optString("kind"), it.optString("name"), it.optLong("at")) }.filter { it.name.isNotBlank() }.sortedBy { it.at }
    return ContentTrip(json.getString("code"), json.optString("title"), json.optLong("createdAt"), members,
        places,
        route,
        json.optJSONArray("contents").list { c ->
            ContentItem(c.getString("id"), c.optString("title"), c.optDouble("seconds", 0.0), c.getLong("at"), c.num("from")?.toLong(), c.num("lat"), c.num("lng"),
                c.str("place"), c.optString("kind"),
                c.optJSONArray("cast").list { ContentPerson(it.getString("participantId"), it.optString("name"), it.optString("character"), seat[it.getString("participantId")]) },
                c.optJSONArray("lines").list { ContentLine(it.getLong("at"), it.str("participantId"), it.str("name"), it.optString("text")) },
                c.getString("url"))
        }.map { it.copy(place = contentWay(it.at, it.place, places)) }.sortedBy { it.at },
        json.num("startedAt")?.toLong(), json.num("endedAt")?.toLong())
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

/** 지도 옆 '동해고속도로 → 하나로마트 → 강릉 숙소': 출발·곧 도착을 뺀 장소 이름을 처음 나온 순서로. */
internal fun contentPlaceChain(places: List<ContentPlace>) = places.filter { it.kind != "start" && it.kind != "approaching" }.map { it.name.trim() }.distinct().joinToString(" → ")

/**
 * Place line of a moment. The server sends the last place name before it. After arriving somewhere (A) and before the next arrival (B),
 * or while approaching B, the design reads 'B 가는 길' (C34 '강릉 숙소 가는 길', player2 '하나로마트 가는 길'). Otherwise the server name stays.
 */
internal fun contentWay(at: Long, place: String?, places: List<ContentPlace>): String? {
    val last = places.lastOrNull { it.at <= at && it.kind in setOf("start", "approaching", "arrived") }
    if (last?.kind == "approaching") return "${last.name.trim()} 가는 길"
    if (last?.kind != "arrived") return place
    val from = last.name.trim()
    val next = places.firstOrNull { it.at > at && it.kind == "arrived" && it.name.trim() != from }
        ?: places.lastOrNull { p -> p.kind == "destination" && p.name.trim() != from && places.none { it.kind == "arrived" && it.at <= at && it.name.trim() == p.name.trim() } }
    return next?.let { "${it.name.trim()} 가는 길" } ?: place
}

/** Map pin label (C35 '아빠보다 빠른 정답'): when long, drop a speaker's '○○의 ', then cut at a word boundary. */
internal fun contentPinLabel(title: String, names: List<String> = emptyList()): String {
    var t = title.trim()
    names.forEach { if (it.isNotBlank() && t.length > 10) t = t.replace("${it}의 ", "") }
    if (t.length <= 10) return t
    val cut = t.take(10).lastIndexOf(' ')
    return t.take(if (cut > 0) cut else 9) + "…"
}

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

/** 숏폼 길이·재생 위치 '0:32'(시안 표지 '▶ 0:32', 플레이어 '0:12 / 0:32'). */
internal fun contentShortClock(seconds: Double) = "${(seconds / 60).toInt()}:%02d".format((seconds % 60).toInt())

/** 표지 날짜 '11.14'. */
internal fun contentCoverDate(at: Long): String = SimpleDateFormat("M.dd", Locale.KOREA).format(Date(at))

/** 표지·플레이어의 따옴표 줄: 장면을 남긴 순간(at)에 가장 가까운 줄(시안 '아빠, 아까부터 바다 보이는데?'). 줄이 없으면 null. */
internal fun contentQuote(item: ContentItem): ContentLine? = item.lines.minByOrNull { kotlin.math.abs(it.at - item.at) }

/** 여행의 처음과 끝 시각(시안 '09:20 — 10:28'): 출발·마지막 도착, 없으면 서버의 주행 시작·끝, 그것도 없으면 콘텐츠 시각. */
internal fun contentTripRange(trip: ContentTrip): Pair<Long, Long> {
    val start = trip.places.firstOrNull { it.kind == "start" }?.at ?: trip.startedAt ?: trip.contents.firstOrNull()?.at ?: trip.createdAt
    val end = trip.places.lastOrNull { it.kind == "arrived" }?.at ?: trip.endedAt ?: trip.contents.lastOrNull()?.at ?: start
    return start to end
}

/** '강릉 가족 여행' → '강릉\n가족 여행'(시안 왼쪽 '주행 날짜와 가족'의 두 줄 제목): 첫 띄어쓰기에서 나눈다. */
internal fun contentTripTitleLines(title: String): String = title.trim().let { t -> t.indexOf(' ').let { if (it > 0) t.substring(0, it) + "\n" + t.substring(it + 1) else t } }

/** 갤러리 제목·표지 글을 시안처럼 두 줄로('아빠보다 빠른\n서준의 정답'): 가운데에 가장 가까운 띄어쓰기에서 나눈다. 짧으면 한 줄. */
internal fun contentTwoLines(title: String): String {
    val t = title.trim()
    if (t.length <= 8) return t
    val cut = t.indices.filter { t[it] == ' ' }.minByOrNull { kotlin.math.abs(it - t.length / 2) } ?: return t
    return t.substring(0, cut) + "\n" + t.substring(cut + 1)
}

/** 표지 바탕의 tint 차례(시안 갤러리: 첫 장면 tint-2, 둘째 tint-3 — D27·C33의 두 장면). 장면 순서로 돈다. */
internal fun contentTint(index: Int): Int = listOf(1, 2, 0, 3, 4)[Math.floorMod(index, 5)]

/**
 * 번들 실제 지도(res/drawable-nodpi/content_map_gangneung, 시안 'Asset / 강릉 실제 지도 / OpenStreetMap' 1200×840, © OpenStreetMap contributors)의 경위도 범위.
 * 그림의 경포호·강릉 공항·성산면 위치로 맞춘 값(메르카토르를 이 넓이에서 선형으로 봄, 닫힌 PR #457). 시연 여행(강릉)의 좌표를 이 그림에 투영한다.
 */
internal const val OSM_WEST = 128.7905
internal const val OSM_EAST = 128.9785
internal const val OSM_NORTH = 37.8184
internal const val OSM_SOUTH = 37.7138

/** 좌표가 번들 지도 안에 있는지. 기록 좌표의 절반 이상이 안이면 실제 지도를, 아니면 도식 지도를 그린다. */
internal fun contentOnBundledMap(points: List<Pair<Double, Double>>): Boolean =
    points.isNotEmpty() && points.count { (lat, lng) -> lat in OSM_SOUTH..OSM_NORTH && lng in OSM_WEST..OSM_EAST } * 2 >= points.size

/** 번들 지도를 w×h 상자에 가운데 맞춰 채울 때(Crop, 시안 object-cover) 경위도 → 상자 좌표. */
internal fun contentOsmProjector(w: Float, h: Float): (Pair<Double, Double>) -> Offset {
    val s = maxOf(w / 1200f, h / 840f)
    val ox = (w - 1200f * s) / 2; val oy = (h - 840f * s) / 2
    return { (lat, lng) -> Offset(ox + ((lng - OSM_WEST) / (OSM_EAST - OSM_WEST) * 1200 * s).toFloat(), oy + ((OSM_NORTH - lat) / (OSM_NORTH - OSM_SOUTH) * 840 * s).toFloat()) }
}

// ---- UI ----

private enum class ContentsPage { GALLERY, TIMELINE, MAP, DETAIL, PLAYER, EXPORT }
private val VIEWS = listOf(ContentsPage.GALLERY to "갤러리", ContentsPage.TIMELINE to "타임라인", ContentsPage.MAP to "지도")
private val SEAT_ORDER = listOf("ROW_1_LEFT", "ROW_1_RIGHT", "ROW_2_LEFT", "ROW_2_CENTER", "ROW_2_RIGHT")
private val SEAT_FALLBACK = listOf(R.drawable.char_basic, R.drawable.char_cap, R.drawable.char_glasses, R.drawable.char_travel, R.drawable.char_game)
private fun characterOf(p: ContentPerson?): Int = ShortCharacter.entries.firstOrNull { it.key == p?.character }?.drawable
    ?: SEAT_FALLBACK[SEAT_ORDER.indexOf(p?.seat).coerceAtLeast(0)]

/** 시안 'Archive / 캐릭터'(동그라미): 캐릭터 그림을 칸에 채운다(CharAvatar, 원). */
@Composable
private fun ContentFace(p: ContentPerson?, size: Dp) = CharAvatar(characterOf(p), size, CircleShape)

/** 숏폼 표지 한 장에 필요한 값. */
private data class CoverData(val date: String, val trip: String, val quote: String, val faces: List<ContentPerson?>, val caption: String, val seconds: Double)

private fun coverOf(item: ContentItem, trip: ContentTrip): CoverData {
    val q = contentQuote(item)
    // mock: 시안 표지 아래 한 줄('서준의 한마디에 모두 웃음', '숙소에 도착하기 직전')은 서버에 원천이 없다. 따옴표 줄을 말한 사람으로 만든 글(#392 표 '목업').
    val caption = q?.name?.takeIf { it.isNotBlank() }?.let { "${it}의 한마디" } ?: trip.title
    return CoverData(contentCoverDate(item.at), trip.title.ifBlank { "함께 탄 여행" }, q?.text ?: item.title, item.cast.take(2), caption, item.seconds)
}

/**
 * 숏폼 표지(시안 'Archive / galleryCar' 400×550이 기준. listCar 104×143·listPhone 62×85·pin 80×110·playerCar 360×640은 같은 그림의 축소).
 * 폭 [width]/400 배로 여백·모서리·글자를 모두 줄이고, [height]가 다르면 가운데 여백만 늘거나 준다(playerCar).
 * 표지 안 글(18.75·40·16.25)은 영상 표지 그림의 글자라 차 화면 글자 단계(CarText)가 아니고, 그림처럼 함께 줄도록 dp로 잰다.
 * 바탕은 tint(CarTints, 차 화면 값), 글은 ink·ink-2. 시안 표지는 같은 변수의 밝은 값(tint-2 #FCF0D9 등)으로 그려져 있다 — 보고 참고.
 */
@Composable
private fun ContentCover(cover: CoverData, tint: Int, width: Dp, height: Dp = width * 550f / 400f) {
    val c = MaterialTheme.colorScheme
    val k = width.value / 400f
    val d = LocalDensity.current
    fun s(v: Float) = with(d) { (v * k).dp.toSp() }
    val small = TextStyle(fontFamily = Pretendard, fontWeight = FontWeight.Medium, fontSize = s(18.75f), lineHeight = s(27.5f))
    Column(Modifier.size(width, height).clip(RoundedCornerShape(25.dp * k)).background(CarTints[tint]).padding(30.dp * k),
        verticalArrangement = Arrangement.spacedBy(20.dp * k)) {
        Text("${cover.date}  ${cover.trip}", style = small, color = c.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(contentTwoLines(cover.quote), style = CarText.Title.copy(fontSize = s(40f), lineHeight = s(55f)),
            color = c.onSurface, maxLines = 2, overflow = TextOverflow.Ellipsis)
        Spacer(Modifier.weight(1f))
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(15.dp * k, Alignment.CenterHorizontally)) {
            cover.faces.forEach { ContentFace(it, 140.dp * k) }
        }
        Text(cover.caption, Modifier.fillMaxWidth(), style = small.copy(fontWeight = FontWeight.Normal, fontSize = s(16.25f), lineHeight = s(22.5f)),
            color = c.onSurfaceVariant, textAlign = TextAlign.Center, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Row(Modifier.fillMaxWidth()) {
            Text("가치타", style = small, color = c.onSurfaceVariant, maxLines = 1)
            Spacer(Modifier.weight(1f))
            Text("▶ ${contentShortClock(cover.seconds)}", style = small, color = c.onSurface, maxLines = 1)
        }
    }
}

/** 시안 'Archive / 보기 전환 / Car'(540×64, surface, 모서리 16, 안쪽 4, 간격 4): 고른 칸만 surface-2(모서리 12)와 굵은 ink, 나머지는 ink-2. */
@Composable
private fun ViewSwitch(page: ContentsPage, onPage: (ContentsPage) -> Unit) {
    val c = MaterialTheme.colorScheme
    Row(Modifier.width(540.dp).height(64.dp).clip(CarShape.Tab).background(c.surface).padding(4.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        VIEWS.forEach { (p, label) ->
            val on = p == page
            Surface(onClick = { onPage(p) }, modifier = Modifier.weight(1f).fillMaxHeight(), shape = RoundedCornerShape(12.dp), color = if (on) c.surfaceVariant else Color.Transparent) {
                Box(contentAlignment = Alignment.Center) {
                    Text(label, style = if (on) CarText.Label.copy(fontWeight = FontWeight.Bold) else CarText.Label, color = if (on) c.onSurface else c.onSurfaceVariant, maxLines = 1)
                }
            }
        }
    }
}

/** 왼쪽 '주행 날짜와 가족'(폭 300, 간격 20): 날짜, 여행 제목 두 줄, 시각, 가족 캐릭터 56(간격 8), 'N명'(누르면 함께 타는 중 — 예전 '우리 가족 프로필' 길). */
@Composable
private fun TripInfo(trip: ContentTrip, members: Int, onFamily: () -> Unit) {
    val c = MaterialTheme.colorScheme
    val (start, end) = contentTripRange(trip)
    Column(Modifier.width(300.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
        Text(SimpleDateFormat("yyyy년 M월 d일", Locale.KOREA).format(Date(start)), style = CarText.Label, color = c.onSurfaceVariant)
        Text(contentTripTitleLines(trip.title.ifBlank { "함께 탄 여행" }), style = CarText.Title, color = c.onSurface)
        Text("${hhmm(start)} — ${hhmm(end)}", style = CarText.Label, color = c.onSurfaceVariant)
        if (trip.members.isNotEmpty()) Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { trip.members.take(4).forEach { ContentFace(it, 56.dp) } }
        Text("우리 가족 ${maxOf(members, trip.members.size)}명", Modifier.clickable(onClick = onFamily), style = CarText.Label, color = c.onSurfaceVariant)
    }
}

/** 주차 화면의 '→' 글 단추(시안 '주행 지도 자세히 보기 →': Label 24, accent). */
@Composable
private fun LinkText(label: String, enabled: Boolean = true, onClick: () -> Unit) =
    Text(label, Modifier.clickable(enabled = enabled, onClick = onClick).padding(vertical = 8.dp), style = CarText.Label,
        color = if (enabled) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)

/** 콘텐츠 기록 탭 본문. token은 지금 여행에서 녹음에 동의한 이 차의 참가자 토큰(없으면 빈 상태). */
@Composable
internal fun ContentsRecord(base: String, code: String, token: String?, canRead: () -> Boolean, canPlay: () -> Boolean,
    onRide: () -> Unit, onStudio: () -> Unit, onActiveChange: (Boolean) -> Unit, members: Int, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val c = MaterialTheme.colorScheme
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

    // 틀(시안 C33–C38): 화면 제목(Title 40 · 12 · Label 24) · 24 · 본문 · 24 · 하단 작업(높이 96, 보기 화면은 숨김).
    Column(modifier, verticalArrangement = Arrangement.spacedBy(24.dp)) {
        val t = trip
        val empty = !loaded || items.isEmpty() || t == null
        val browse = page in listOf(ContentsPage.GALLERY, ContentsPage.TIMELINE, ContentsPage.MAP)
        val (title, sub) = when {
            empty -> "콘텐츠 기록" to "우리 가족 / 차량과 폰에서 이어보기"
            page == ContentsPage.PLAYER && item != null -> item.title to listOfNotNull("${monthDay(item.at)} ${hhmm(item.at)}", item.place).joinToString("  ")
            page == ContentsPage.EXPORT && item != null -> "영상이 준비됐어요" to "내 계정에 저장한 가족의 숏폼"
            page == ContentsPage.DETAIL -> "이 길에서 나눈 이야기" to "지도에서 선택한 우리 가족의 장면"
            else -> "콘텐츠 기록" to "" // 시안 v3 보기 화면: 부제는 숨김
        }
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
            TitleBlock(title, sub, Modifier.weight(1f))
            // 시안에는 없지만 예전 쇼츠 스튜디오(생성·보관함·공용 보관함 삭제) 길을 남긴다(#392). 자리만 제목 줄 오른쪽 글 단추로.
            if (loaded && (browse || empty)) LinkText("쇼츠 만들기·보관함") { stop(); onStudio() }
        }
        val pickedId = (items.firstOrNull { it.id == pin } ?: items.firstOrNull { it.lat != null } ?: items.firstOrNull())?.id
        Box(Modifier.weight(1f).fillMaxWidth()) {
            when {
                !loaded -> Text("콘텐츠 기록을 불러오고 있어요", style = CarText.Label, color = c.onSurfaceVariant)
                empty -> Text(note.ifBlank { "아직 생성한 콘텐츠가 없어요.\n여행을 마친 뒤 대화에서 장면을 골라 보세요." }, style = CarText.Headline, color = c.onSurfaceVariant)
                page == ContentsPage.PLAYER && item != null -> PlayerBody(item, t!!, contentTint(items.indexOf(item)), position, playing, busy, note, ::toggle)
                page == ContentsPage.EXPORT && item != null -> ExportBody(item, t!!, contentTint(items.indexOf(item)), saved != null, busy, note, ::export)
                page == ContentsPage.DETAIL -> MapWithList(t!!, items, pin = pickedId, link = false, onPin = { pin = it }, onOpen = ::open)
                else -> Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(28.dp)) {
                    ViewSwitch(if (browse) page else ContentsPage.GALLERY) { page = it }
                    when (page) {
                        ContentsPage.TIMELINE -> Timeline(t!!, items, members, onRide, ::open)
                        ContentsPage.MAP -> MapWithList(t!!, items, pin = pin, link = true, onPin = { pin = it; page = ContentsPage.DETAIL }, onOpen = ::open,
                            onMore = { page = ContentsPage.DETAIL })
                        else -> Gallery(t!!, items, members, onRide, ::open)
                    }
                }
            }
        }
        // 하단 작업. 갤러리·타임라인·지도는 시안에서 숨김(보기 전환과 '주행 지도 자세히 보기 →'로 옮김). 플레이어는 2026:3146('콘텐츠 기록' 440 + '영상 내보내기' 1138).
        when {
            empty -> CarButton("함께 타는 중으로", onClick = onRide)
            page == ContentsPage.PLAYER -> Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(24.dp)) {
                CarButton("콘텐츠 기록", Modifier.weight(440f), CarButtonKind.Secondary) { stop(); page = ContentsPage.GALLERY }
                CarButton("영상 내보내기", Modifier.weight(1138f)) { player?.pause(); playing = false; page = ContentsPage.EXPORT }
            }
            page == ContentsPage.EXPORT -> CarButton("콘텐츠 기록으로") { stop(); page = ContentsPage.GALLERY }
            page == ContentsPage.DETAIL -> Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(24.dp)) {
                CarButton("지도로 돌아가기", Modifier.weight(440f), CarButtonKind.Secondary) { page = ContentsPage.MAP }
                CarButton("이 장면 보기", Modifier.weight(1138f)) { pickedId?.let(::open) }
            }
            else -> {}
        }
    }
}

/** C33 갤러리: 왼쪽 주행 정보(300) · 40 · 숏폼 표지 400×550 격자(가로 24, 세로 32). 표지 아래 제목 두 줄(Headline 32) · 16 · '09:32  동해고속도로'(Label 24). */
@Composable
private fun Gallery(trip: ContentTrip, items: List<ContentItem>, members: Int, onFamily: () -> Unit, onOpen: (String) -> Unit) {
    val c = MaterialTheme.colorScheme
    Row(Modifier.fillMaxSize().verticalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(40.dp)) {
        TripInfo(trip, members, onFamily)
        BoxWithConstraints(Modifier.weight(1f)) {
            val cols = ((maxWidth + 24.dp) / 424.dp).toInt().coerceAtLeast(1)
            Column(verticalArrangement = Arrangement.spacedBy(32.dp)) {
                items.chunked(cols).forEach { row ->
                    Row(horizontalArrangement = Arrangement.spacedBy(24.dp)) {
                        row.forEach { x ->
                            Column(Modifier.width(400.dp).clip(CarShape.Ctl).clickable { onOpen(x.id) }, verticalArrangement = Arrangement.spacedBy(16.dp)) {
                                ContentCover(coverOf(x, trip), contentTint(items.indexOf(x)), 400.dp)
                                Text(contentTwoLines(x.title), style = CarText.Headline, color = c.onSurface, maxLines = 2, overflow = TextOverflow.Ellipsis)
                                Text(listOfNotNull(hhmm(x.at), x.place).joinToString("  "), style = CarText.Label, color = c.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }
                        }
                    }
                }
            }
        }
    }
}

/** C34 타임라인: 왼쪽 주행 정보 · 40 · 시간순 목록(간격 24): '09:20  출발', 장면 줄(시각 88 · 24 · 표지 104×143 · 24 · 제목/장소·길이/따옴표 줄), '10:28  강릉 숙소 도착'. */
@Composable
private fun Timeline(trip: ContentTrip, items: List<ContentItem>, members: Int, onFamily: () -> Unit, onOpen: (String) -> Unit) {
    val c = MaterialTheme.colorScheme
    Row(Modifier.fillMaxSize().verticalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(40.dp)) {
        TripInfo(trip, members, onFamily)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(24.dp)) {
            trip.places.firstOrNull { it.kind == "start" }?.let { Text("${hhmm(it.at)}  출발", style = CarText.Label, color = c.onSurfaceVariant) }
            items.forEachIndexed { i, x ->
                Row(Modifier.fillMaxWidth().clip(CarShape.Ctl).clickable { onOpen(x.id) }, horizontalArrangement = Arrangement.spacedBy(24.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(hhmm(x.at), Modifier.width(88.dp), style = CarText.Label, color = c.onSurfaceVariant)
                    ContentCover(coverOf(x, trip), contentTint(i), 104.dp, 143.dp)
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Text(x.title, style = CarText.Headline, color = c.onSurface, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(listOfNotNull(x.place, contentShortClock(x.seconds)).joinToString("  "), style = CarText.Label, color = c.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        contentQuote(x)?.let { Text("“${it.text}”", style = CarText.Label, color = c.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                    }
                }
            }
            trip.places.lastOrNull { it.kind == "arrived" }?.let { Text("${hhmm(it.at)}  ${it.name.trim()} 도착", style = CarText.Label, color = c.onSurfaceVariant) }
        }
    }
}

/** C37 플레이어 본문(가운데, 간격 64): 표지 playerCar 360×640 · '이 장면의 대화'(620, 간격 28): '○○의 한마디', 따옴표 줄(Title 40), '09:32  동해고속도로', 재생 위치(4), 재생 글 단추. */
@Composable
private fun PlayerBody(item: ContentItem, trip: ContentTrip, tint: Int, position: Double, playing: Boolean, busy: Boolean, note: String, onToggle: () -> Unit) {
    val c = MaterialTheme.colorScheme
    // 재생 전에는 장면을 남긴 순간의 줄(시안 '미리보기'), 재생을 시작한 뒤에는 지금 위치의 줄.
    val said = if (position > 0 || playing) contentLineAt(item, position) else contentQuote(item)
    Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(64.dp, Alignment.CenterHorizontally), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.clip(RoundedCornerShape(22.5.dp)).clickable(enabled = !busy, onClick = onToggle)) { ContentCover(coverOf(item, trip), tint, 360.dp, 640.dp) }
        Column(Modifier.width(620.dp), verticalArrangement = Arrangement.spacedBy(28.dp)) {
            Text(said?.name?.takeIf { it.isNotBlank() }?.let { "${it}의 한마디" } ?: "이 장면의 한마디", style = CarText.Label, color = c.onSurfaceVariant)
            Text("“${said?.text ?: item.title}”", style = CarText.Title, color = c.onSurface)
            Text(listOfNotNull(hhmm(item.at), item.place).joinToString("  "), style = CarText.Label, color = c.onSurfaceVariant)
            // 시안 '재생 위치'(620×4, line). 지난 만큼을 ink-2로 채운다(시안에는 채움이 없음).
            Box(Modifier.fillMaxWidth().height(4.dp).background(c.outlineVariant)) {
                Box(Modifier.fillMaxWidth((position / item.seconds.coerceAtLeast(0.1)).toFloat().coerceIn(0f, 1f)).fillMaxHeight().background(c.onSurfaceVariant))
            }
            val label = when { playing -> "Ⅱ  일시정지"; position > 0 -> "▶  이어서 재생"; else -> "▶  미리보기 재생" }
            Text("$label   ${contentShortClock(position)} / ${contentShortClock(item.seconds)}", Modifier.clickable(enabled = !busy, onClick = onToggle).padding(vertical = 8.dp),
                style = CarText.Label, color = c.onSurface)
            if (busy) Text("영상을 받고 있어요", style = CarText.Label, color = c.onSurfaceVariant)
            if (note.isNotBlank()) Text(note, style = CarText.Label, color = c.onSurfaceVariant)
        }
    }
}

/**
 * C38 내보내기 본문(가운데, 간격 64): 표지 360×640 · '내보내기 정보'(700, 간격 24): 제목(Title 40), 'MP4  /  9:16  /  32초', '캐릭터와 우리 목소리 그대로'(Body 28), 안내(Label 24).
 * 시안에는 저장 단추가 없다. 지금 동작(이 기기 Movies/Gachita에 저장하고 공유 시트)을 지도 화면의 '→' 글 단추 모양으로 안내 아래에 둔다.
 */
@Composable
private fun ExportBody(item: ContentItem, trip: ContentTrip, tint: Int, saved: Boolean, busy: Boolean, note: String, onExport: () -> Unit) {
    val c = MaterialTheme.colorScheme
    Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(64.dp, Alignment.CenterHorizontally), verticalAlignment = Alignment.CenterVertically) {
        ContentCover(coverOf(item, trip), tint, 360.dp, 640.dp)
        Column(Modifier.width(700.dp), verticalArrangement = Arrangement.spacedBy(24.dp)) {
            Text(item.title, style = CarText.Title, color = c.onSurface)
            // mock: 형식 글(MP4 · 9:16)은 서버 파일 검사가 지키는 값이라 시안 글 그대로, 길이만 데이터.
            Text("MP4  /  9:16  /  ${item.seconds.toInt()}초", style = CarText.Label, color = c.onSurfaceVariant)
            Text("캐릭터와 우리 목소리 그대로", style = CarText.Body, color = c.onSurface)
            Text("내 계정의 콘텐츠 기록에서\n폰으로 저장하고 공유할 수 있어요.", style = CarText.Label, color = c.onSurfaceVariant)
            LinkText(if (busy) "영상을 받고 있어요" else if (saved) "공유할 앱 다시 고르기 →" else "이 기기에 저장하고 공유하기 →", enabled = !busy, onClick = onExport)
            if (note.isNotBlank()) Text(note, style = CarText.Label, color = c.onSurfaceVariant)
        }
    }
}

/**
 * C35 지도·C36 상세 '실제 지도와 장면': 지도(1080×660, 남는 폭) · 28 · '지도 속 장면 목록'(494, 간격 16): 여행 제목(Title 40), '11월 14일  09:20 — 10:28', 장소 줄,
 * 장면 링크(표지 62×85 · 16 · 제목 두 줄 Body 28 / '09:32  0:32'), 지도 화면만 '주행 지도 자세히 보기 →'.
 */
@Composable
private fun MapWithList(trip: ContentTrip, items: List<ContentItem>, pin: String?, link: Boolean, onPin: (String) -> Unit, onOpen: (String) -> Unit, onMore: () -> Unit = {}) {
    val c = MaterialTheme.colorScheme
    val (start, end) = contentTripRange(trip)
    Row(Modifier.fillMaxWidth().heightIn(max = 660.dp), horizontalArrangement = Arrangement.spacedBy(28.dp)) {
        MapBox(trip, items, pin, Modifier.weight(1f).fillMaxHeight(), onPin)
        Column(Modifier.width(494.dp).fillMaxHeight().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Text(trip.title.ifBlank { "함께 탄 여행" }, style = CarText.Title, color = c.onSurface)
            Text("${monthDay(start)}  ${hhmm(start)} — ${hhmm(end)}", style = CarText.Label, color = c.onSurfaceVariant)
            contentPlaceChain(trip.places).takeIf { it.isNotBlank() }?.let { Text(it, style = CarText.Label, color = c.onSurfaceVariant) }
            items.forEachIndexed { i, x ->
                Row(Modifier.fillMaxWidth().clip(CarShape.Tab).clickable { onOpen(x.id) }, horizontalArrangement = Arrangement.spacedBy(16.dp), verticalAlignment = Alignment.CenterVertically) {
                    ContentCover(coverOf(x, trip), contentTint(i), 62.dp, 85.dp)
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(contentTwoLines(x.title), style = CarText.Body, color = if (!link && pin == x.id) c.primary else c.onSurface, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        Text("${hhmm(x.at)}  ${contentShortClock(x.seconds)}", style = CarText.Label, color = c.onSurfaceVariant)
                    }
                }
            }
            if (link) LinkText("주행 지도 자세히 보기 →", onClick = onMore)
        }
    }
}

/**
 * 지도 상자(모서리 24). 기록 좌표가 번들 강릉 지도 안이면 그 그림(Crop) 위에, 아니면 surface-2 도식 바탕 위에 투영한다.
 * 길: 시안 'Frame' 벡터처럼 흰 12 위에 짙은 초록 6(흰 = ink, 초록 = accent-soft — 시안 #20775B에 가장 가까운 역할). 장면 액자: 'Archive / pin'(88, 바탕 bg, 안쪽 4,
 * 표지 윗부분이 보임). 액자 아래 가운데가 그 지점. 출처 '© OpenStreetMap contributors'(시안 13, 지도 그림의 이용 조건이라 차 글자 단계 밖).
 */
@Composable
private fun MapBox(trip: ContentTrip, items: List<ContentItem>, pin: String?, modifier: Modifier, onPin: (String) -> Unit) {
    val c = MaterialTheme.colorScheme
    BoxWithConstraints(modifier.clip(CarShape.Ctl).background(c.surfaceVariant)) {
        val density = LocalDensity.current
        val w = with(density) { maxWidth.toPx() }; val h = with(density) { maxHeight.toPx() }
        val pins = items.filter { it.lat != null && it.lng != null }
        val points = trip.route + pins.map { it.lat!! to it.lng!! }
        val real = contentOnBundledMap(points)
        val project = if (real) contentOsmProjector(w, h) else contentProjector(points, w, h, with(density) { 120.dp.toPx() })
        if (real) Image(painterResource(R.drawable.content_map_gangneung), "강릉 지도", Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
        Canvas(Modifier.fillMaxSize()) {
            if (project != null && trip.route.size > 1) {
                val path = Path().apply { trip.route.forEachIndexed { i, p -> val o = project(p); if (i == 0) moveTo(o.x, o.y) else lineTo(o.x, o.y) } }
                drawPath(path, c.onSurface, style = Stroke(12.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round))
                drawPath(path, if (real) c.primaryContainer else c.primary, style = Stroke(6.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round))
            }
        }
        if (project == null) Text("기록한 위치가 없어 길을 그리지 못했어요.", Modifier.align(Alignment.BottomStart).padding(24.dp), style = CarText.Label, color = c.onSurfaceVariant)
        project?.let { pr -> pins.forEach { x ->
            val o = pr(x.lat!! to x.lng!!)
            val dx = with(density) { (o.x - 44.dp.toPx()).coerceIn(0f, (w - 88.dp.toPx()).coerceAtLeast(0f)).toDp() }
            val dy = with(density) { (o.y - 88.dp.toPx()).coerceIn(0f, (h - 88.dp.toPx()).coerceAtLeast(0f)).toDp() }
            Surface(onClick = { onPin(x.id) }, shape = CarShape.Tab, color = c.background, border = if (pin == x.id) BorderStroke(3.dp, c.primary) else null,
                modifier = Modifier.offset(dx, dy).size(88.dp)) {
                Box(Modifier.padding(4.dp).clip(RoundedCornerShape(4.5.dp))) {
                    Box(Modifier.wrapContentHeight(Alignment.Top, unbounded = true)) { ContentCover(coverOf(x, trip), contentTint(items.indexOf(x)), 80.dp, 110.dp) }
                }
            }
        } }
        if (real) Text("© OpenStreetMap contributors", Modifier.align(Alignment.BottomStart).padding(start = 10.dp, bottom = 4.dp),
            style = TextStyle(fontFamily = Pretendard, fontSize = 13.sp, lineHeight = 18.sp), color = c.surfaceVariant)
    }
}
