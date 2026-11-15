package io.github.teampitcrew.gachita

import androidx.compose.foundation.layout.size
import androidx.compose.ui.viewinterop.AndroidView
import android.view.TextureView
import android.view.Surface
import android.graphics.SurfaceTexture
import android.media.MediaPlayer
import androidx.annotation.DrawableRes
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
import androidx.compose.ui.graphics.PathEffect
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

/*
 * '콘텐츠 기록' 탭 본문(원본 Figma Y7zFqGUEAFDWTumG30MsOs '민준 개선안' 2004:57의 현재 판: C33 갤러리 2005:4482, C34 타임라인 2005:4522,
 * C35 지도 2005:4562, C36 상세 2005:4601, C37 플레이어 2005:4640(재생 중 2081:4294·일시정지 2083:4309), C38 내보내기 2005:4668,
 * D27–D32, D補 emptyContent 2026:2473·player2/3·export2/3, 하단 작업 2026:3146). 머리 줄과 위 탭은 MainActivity가 Shell.PARKED로 그린다.
 * 서버 값으로만 그린다(docs/api/places.md):
 * - 차는 프로필 토큰이 없어(계정 로그인은 흐름 F1) 지금 여행 하나를 GET /trips/{code}/contents(동의한 참가자 토큰)로 읽는다.
 * - 장소·경로·자막 줄은 녹음에 동의한 참가자에게만 온다. 없으면 그 칸을 비워 그리고 지어내지 않는다.
 * - 영상 파일은 그 여행의 참가자 토큰으로 받는다(전원 동의 규칙, short-assets.md). C38 내보내기는 안내만 있고(시안 글 '폰으로 저장하고 공유'),
 *   차에서 저장·공유하지 않는다(11/15 오너: C#에 없는 것은 덜어냄).
 * 지도는 번들 OpenStreetMap 그림(시안 'Asset / 강릉 실제 지도 / OpenStreetMap' 2067:3071, 실행 중 타일 서버를 부르지 않음) 위에 기록한 좌표를 투영한다.
 * 좌표가 그 그림 밖이면 지도 제공자 없이 상자에 투영한 도식 지도다(개편 계획 결정 5).
 */

internal data class ContentPerson(val id: String, val name: String, val character: String, val seat: String? = null)
internal data class ContentLine(val at: Long, val participantId: String?, val name: String?, val text: String)
internal data class ContentPlace(val kind: String, val name: String, val at: Long, val lat: Double? = null, val lng: Double? = null)
internal data class ContentItem(val id: String, val title: String, val seconds: Double, val at: Long, val from: Long?, val lat: Double?, val lng: Double?,
    val place: String?, val kind: String, val cast: List<ContentPerson>, val lines: List<ContentLine>, val url: String, val momentId: String? = null)

/**
 * C32 완성 표지 → C37 플레이어(시안 '완성 장면 1 → C37', '완성 장면 3 → player3'): 여행 마무리(AfterTrip)가 고른 장면의 id를 남기고 콘텐츠 기록을 열면,
 * 콘텐츠 기록은 목록을 읽은 뒤 그 장면의 플레이어를 바로 연다. 한 번 쓰면 비운다.
 */
internal object ContentLink { var moment: String? = null }
internal data class ContentTrip(val code: String, val title: String, val createdAt: Long, val members: List<ContentPerson>, val places: List<ContentPlace>,
    val route: List<Pair<Double, Double>>, val contents: List<ContentItem>, val startedAt: Long? = null, val endedAt: Long? = null,
    val routeAt: List<Long> = emptyList(), val groupName: String? = null) {
    /** 화면에 부르는 무리 이름: 동승 그룹이면 그 이름(PITCREW), 가족 그룹·그룹 없는 여행이면 '우리 가족'(시안 글). */
    val crew get() = groupName?.takeIf { it.isNotBlank() } ?: "우리 가족"
}

private fun JSONObject.str(key: String): String? = if (isNull(key) || !has(key)) null else optString(key)
private fun JSONObject.num(key: String): Double? = if (isNull(key) || !has(key)) null else optDouble(key).takeIf { !it.isNaN() }
private fun <T> JSONArray?.list(f: (JSONObject) -> T): List<T> = if (this == null) emptyList() else (0 until length()).map { f(getJSONObject(it)) }

/** GET /trips/{code}/contents·/profiles/me/trips 항목 하나. 새 칸(cast·lines·from·startedAt·endedAt)이 없는 옛 서버여도 읽는다. */
internal fun parseContentTrip(json: JSONObject): ContentTrip {
    val members = json.optJSONArray("members").list { ContentPerson(it.getString("participantId"), it.optString("name"), it.optString("character"), it.str("seat")) }
    val seat = members.associate { it.id to it.seat }
    val points = json.optJSONArray("route")?.let { a -> (0 until a.length()).map { a.getJSONArray(it) } }.orEmpty()
    val route = points.map { it.getDouble(0) to it.getDouble(1) }
    val routeAt = points.map { it.optLong(2, -1) }.takeIf { at -> at.none { it < 0 } }.orEmpty() // [lat, lng, at] — 시각이 없는 옛 서버면 비움
    val places = json.optJSONArray("places").list { ContentPlace(it.optString("kind"), it.optString("name"), it.optLong("at"), it.num("lat"), it.num("lng")) }.filter { it.name.isNotBlank() }.sortedBy { it.at }
    return ContentTrip(json.getString("code"), json.optString("title"), json.optLong("createdAt"), members,
        places,
        route,
        json.optJSONArray("contents").list { c ->
            ContentItem(c.getString("id"), c.optString("title"), c.optDouble("seconds", 0.0), c.getLong("at"), c.num("from")?.toLong(), c.num("lat"), c.num("lng"),
                c.str("place"), c.optString("kind"),
                c.optJSONArray("cast").list { ContentPerson(it.getString("participantId"), it.optString("name"), it.optString("character"), seat[it.getString("participantId")]) },
                c.optJSONArray("lines").list { ContentLine(it.getLong("at"), it.str("participantId"), it.str("name"), it.optString("text")) },
                c.getString("url"), c.str("momentId"))
        }.map { it.copy(place = contentWay(it.at, it.place, places)) }.sortedBy { it.at },
        json.num("startedAt")?.toLong(), json.num("endedAt")?.toLong(), routeAt, json.str("groupName"))
}

private fun hhmm(at: Long) = SimpleDateFormat("HH:mm", Locale.KOREA).format(Date(at))
internal fun monthDay(at: Long) = SimpleDateFormat("M월 d일", Locale.KOREA).format(Date(at))

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

/** 표지 바탕의 tint 차례(시안 'Archive / galleryCar / 1·2·3' = 장면 1·2·3이 tint-2·tint-1·tint-3, 넷째부터 tint-4·5). 장면 순서로 돈다. */
internal fun contentTint(index: Int): Int = listOf(1, 0, 2, 3, 4)[Math.floorMod(index, 5)]

/**
 * 지도 위 장면 액자 자리: 장면 좌표, 없으면 장면 시각에 가장 가까운 경로 점(경로 [lat, lng, at]).
 * 둘 다 없으면 출발→도착 직선 위 시각 비율 자리(추정 — 지도에는 점선으로 그린 그 선 위). 끝점도 없으면 null.
 */
internal fun contentSpot(item: ContentItem, trip: ContentTrip): Pair<Double, Double>? {
    if (item.lat != null && item.lng != null) return item.lat to item.lng
    trip.routeAt.indices.minByOrNull { kotlin.math.abs(trip.routeAt[it] - item.at) }?.let { i -> trip.route.getOrNull(i)?.let { return it } }
    val (a, b) = contentEnds(trip)
    if (a == null) return null
    if (b == null || b.at <= a.at) return a.lat!! to a.lng!!
    val f = ((item.at - a.at).toDouble() / (b.at - a.at)).coerceIn(0.0, 1.0)
    return a.lat!! + (b.lat!! - a.lat) * f to a.lng!! + (b.lng!! - a.lng) * f
}

/** 지도 끝점(장소 기록의 좌표): 좌표 있는 첫 출발(없으면 첫 장소)과 좌표 있는 마지막 도착·목적지·곧 도착(없으면 마지막 장소). 하나뿐이면 끝은 null. */
internal fun contentEnds(trip: ContentTrip): Pair<ContentPlace?, ContentPlace?> {
    val known = trip.places.filter { it.lat != null && it.lng != null }
    val start = known.firstOrNull { it.kind == "start" } ?: known.firstOrNull()
    val end = known.lastOrNull { it.kind in setOf("arrived", "destination", "approaching") } ?: known.lastOrNull()
    return start to end?.takeIf { it !== start }
}

/**
 * 번들 실제 지도 한 장(1200×840, © OpenStreetMap contributors)과 그 그림 가장자리의 경위도. 메르카토르를 이 넓이에서 선형으로 본다(오차 1px 아래).
 * 강릉: 시안 'Asset / 강릉 실제 지도 / OpenStreetMap', 경포호·강릉 공항·성산면 위치로 맞춤(닫힌 PR #457).
 * 강남–분당: OSM 표준 타일 z12를 한 번 이어 붙여 원래 크기로 자름(신논현–정자 카페거리 시연, 위로 한강·아래로 정자까지).
 */
internal class BundledMap(@DrawableRes val res: Int, val label: String, val west: Double, val east: Double, val north: Double, val south: Double) {
    fun has(lat: Double, lng: Double) = lat in south..north && lng in west..east
}
internal val BUNDLED_MAPS = listOf(
    BundledMap(R.drawable.content_map_gangneung, "강릉 지도", 128.7905, 128.9785, 37.8184, 37.7138),
    BundledMap(R.drawable.content_map_gangnam_bundang, "서울 강남–성남 분당 지도", 126.8619, 127.2739, 37.5549, 37.3259),
)

/** 기록 좌표의 절반 이상이 안에 드는 번들 지도. 좌표가 하나도 없으면 시연 지역(강남–분당) 지도 — 빈 판을 보이지 않는다. 좌표가 모두 밖이면 null(도식 지도). */
internal fun contentBundledMap(points: List<Pair<Double, Double>>): BundledMap? =
    if (points.isEmpty()) BUNDLED_MAPS.first { it.res == R.drawable.content_map_gangnam_bundang } else BUNDLED_MAPS.firstOrNull { m -> points.count { (lat, lng) -> m.has(lat, lng) } * 2 >= points.size }

/** 번들 지도를 w×h 상자에 가운데 맞춰 채울 때(Crop, 시안 object-cover) 경위도 → 상자 좌표. */
internal fun contentOsmProjector(m: BundledMap, w: Float, h: Float): (Pair<Double, Double>) -> Offset {
    val s = maxOf(w / 1200f, h / 840f)
    val ox = (w - 1200f * s) / 2; val oy = (h - 840f * s) / 2
    return { (lat, lng) -> Offset(ox + ((lng - m.west) / (m.east - m.west) * 1200 * s).toFloat(), oy + ((m.north - lat) / (m.north - m.south) * 840 * s).toFloat()) }
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
private data class CoverData(val date: String, val trip: String, val quote: String, val faces: List<ContentPerson?>, val caption: String, val seconds: Double,
    val image: androidx.compose.ui.graphics.ImageBitmap? = null) // image: 일꾼이 만든 표지 그림(C32 DoneScene과 같음). mock: 지금은 시연 팩의 표지만(DemoPack.kt)

private fun coverOf(item: ContentItem, trip: ContentTrip): CoverData {
    val q = contentQuote(item)
    // mock: 시안 표지 아래 한 줄('서준의 한마디에 모두 웃음', '숙소에 도착하기 직전')은 서버에 원천이 없다. 따옴표 줄을 말한 사람으로 만든 글(#392 표 '목업').
    val caption = q?.name?.takeIf { it.isNotBlank() }?.let { "${it}의 한마디" } ?: trip.title
    return CoverData(contentCoverDate(item.at), trip.title.ifBlank { "함께 탄 여행" }, q?.text ?: item.title, item.cast.take(2), caption, item.seconds, Demo.covers[item.id])
}

/**
 * 숏폼 표지(시안 'Archive / galleryCar' 400×550이 기준. listCar 104×143·listPhone 62×85·pin 80×110·playerCar 360×640은 같은 그림의 축소).
 * 폭 [width]/400 배로 여백·모서리·글자를 모두 줄이고, [height]가 다르면 가운데 여백만 늘거나 준다(playerCar).
 * 표지 안 글(18.75·40·16.25)은 영상 표지 그림의 글자라 차 화면 글자 단계(CarText)가 아니고, 그림처럼 함께 줄도록 dp로 잰다.
 * 바탕·글은 시안 그대로 밝은 종이 값(CarPaper: tint-1–5·ink·ink-2의 밝은 값). 표지는 어두운 화면 위에 놓는 그림이다.
 */
@Composable
private fun ContentCover(cover: CoverData, tint: Int, width: Dp, height: Dp = width * 550f / 400f) {
    val k = width.value / 400f
    val d = LocalDensity.current
    fun s(v: Float) = with(d) { (v * k).dp.toSp() }
    val small = TextStyle(fontFamily = Pretendard, fontWeight = FontWeight.Medium, fontSize = s(18.75f), lineHeight = s(27.5f))
    Box(Modifier.size(width, height).clip(RoundedCornerShape(25.dp * k)).background(CarPaper.Tints[tint % CarPaper.Tints.size])) {
      // 표지 그림이 있으면 바탕으로 깔고 캐릭터 줄은 뺀다(그림에 캐릭터가 있다, AfterTrip DoneScene과 같음)
      if (cover.image != null) Image(cover.image, null, Modifier.matchParentSize(), contentScale = ContentScale.Crop)
      Column(Modifier.fillMaxSize().padding(30.dp * k), verticalArrangement = Arrangement.spacedBy(20.dp * k)) {
        Text("${cover.date}  ${cover.trip}", style = small, color = CarPaper.Ink2, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(contentTwoLines(cover.quote), style = CarText.Title.copy(fontSize = s(40f), lineHeight = s(55f)),
            color = CarPaper.Ink, maxLines = 2, overflow = TextOverflow.Ellipsis)
        Spacer(Modifier.weight(1f))
        if (cover.image == null) Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(15.dp * k, Alignment.CenterHorizontally)) {
            cover.faces.forEach { ContentFace(it, 140.dp * k) }
        }
        Text(cover.caption, Modifier.fillMaxWidth(), style = small.copy(fontWeight = FontWeight.Normal, fontSize = s(16.25f), lineHeight = s(22.5f)),
            color = CarPaper.Ink2, textAlign = TextAlign.Center, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Row(Modifier.fillMaxWidth()) {
            Text("가치타", style = small, color = CarPaper.Ink2, maxLines = 1)
            Spacer(Modifier.weight(1f))
            Text("▶ ${contentShortClock(cover.seconds)}", style = small, color = CarPaper.Ink, maxLines = 1)
        }
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

/**
 * 왼쪽 '주행 날짜와 가족'(갤러리 폭 300, 타임라인 361, 간격 20): 날짜, 여행 제목 두 줄, 시각, 가족 캐릭터 56(간격 8), 'N명'.
 * 가족 캐릭터('우리 가족 프로필')와 'N명'은 시안대로 C16 groups(내 동승 그룹)로 간다(onFamily).
 */
@Composable
private fun TripInfo(trip: ContentTrip, members: Int, onFamily: () -> Unit, width: Dp = 300.dp) {
    val c = MaterialTheme.colorScheme
    val (start, end) = contentTripRange(trip)
    Column(Modifier.width(width), verticalArrangement = Arrangement.spacedBy(20.dp)) {
        Text(SimpleDateFormat("yyyy년 M월 d일", Locale.KOREA).format(Date(start)), style = CarText.Label, color = c.onSurfaceVariant)
        Text(contentTripTitleLines(trip.title.ifBlank { "함께 탄 여행" }), style = CarText.Title, color = c.onSurface)
        Text("${hhmm(start)} — ${hhmm(end)}", style = CarText.Label, color = c.onSurfaceVariant)
        if (trip.members.isNotEmpty()) Row(Modifier.clickable(onClick = onFamily), horizontalArrangement = Arrangement.spacedBy(8.dp)) { trip.members.take(4).forEach { ContentFace(it, 56.dp) } }
        Text("${trip.crew} ${maxOf(members, trip.members.size)}명", Modifier.clickable(onClick = onFamily), style = CarText.Label, color = c.onSurfaceVariant)
    }
}

/** 시안 '주행 지도 자세히 보기 →'(Label 24, accent 글 단추). */
@Composable
private fun LinkText(label: String, onClick: () -> Unit) =
    Text(label, Modifier.clickable(onClick = onClick), style = CarText.Label, color = MaterialTheme.colorScheme.primary)

/**
 * 콘텐츠 기록 탭 본문. token은 지금 여행에서 녹음에 동의한 이 차의 참가자 토큰(없으면 빈 상태).
 */
@Composable
internal fun ContentsRecord(base: String, code: String, token: String?, canRead: () -> Boolean, canPlay: () -> Boolean,
    onRide: () -> Unit, onActiveChange: (Boolean) -> Unit, members: Int, modifier: Modifier = Modifier, onFamily: () -> Unit = onRide,
    demo: ContentTrip? = null) { // mock: 시연 팩의 콘텐츠 기록(DemoPack.kt). 있으면 서버를 읽지 않고 영상은 앱에 든 파일로
    val context = LocalContext.current
    val c = MaterialTheme.colorScheme
    val read by rememberUpdatedState(canRead)
    val play by rememberUpdatedState(canPlay)
    val scope = rememberCoroutineScope()
    val api = remember(base) { Server(base) }
    var trip by remember { mutableStateOf<ContentTrip?>(null) }
    var loaded by remember { mutableStateOf(false) }
    var empty by remember { mutableStateOf("") } // 읽지 못한 까닭(빈 상태 본문 자리)
    var toast by remember { mutableStateOf("") } // 재생·저장 실패와 결과(시안 알림 조각 CarToast)
    var page by remember { mutableStateOf(ContentsPage.GALLERY) }
    var selected by remember { mutableStateOf<String?>(null) }
    var file by remember { mutableStateOf<Pair<String, File>?>(null) }
    var player by remember { mutableStateOf<MediaPlayer?>(null) }
    var playing by remember { mutableStateOf(false) }
    var position by remember { mutableStateOf(0.0) }
    var busy by remember { mutableStateOf(false) }

    fun stop() { runCatching { player?.release() }; player = null; playing = false; position = 0.0 }
    DisposableEffect(Unit) {
        onActiveChange(true); CaptureService.hold(true)
        onDispose { stop(); file?.second?.delete(); CaptureService.hold(false); onActiveChange(false) }
    }
    // 들어올 때마다 읽고(MainActivity가 진입마다 새로 그림), 머무는 동안 10초마다 다시 읽는다 — 만들기가 끝난 쇼츠가 나가지 않아도 보이게.
    // 다시 읽다 실패하면 보이던 기록을 그대로 둔다. ponytail: 10초 조회, 서버가 새 쇼츠를 알리게 되면 그 신호로.
    LaunchedEffect(code, token) {
        loaded = false; empty = ""
        if (demo != null) { trip = demo; loaded = true; return@LaunchedEffect }
        while (true) {
            if (token == null || !read()) { if (trip == null) loaded = true }
            else try {
                trip = withContext(Dispatchers.IO) { parseContentTrip(JSONObject(api.contents(code, token))) }; empty = ""; loaded = true
            } catch (e: kotlinx.coroutines.CancellationException) { throw e }
            catch (e: Exception) {
                if (trip == null) { empty = if (e is ApiError && e.status == 403) "기록에 동의한 사람만 콘텐츠 기록을 볼 수 있어요" else e.message ?: "연결을 확인해 주세요"; loaded = true }
            }
            if (token == null) break
            delay(10_000)
        }
    }
    LaunchedEffect(playing) { while (playing) { position = (player?.currentPosition ?: 0) / 1000.0; delay(250) } }
    LaunchedEffect(play()) { if (!play()) stop() }
    LaunchedEffect(toast) { if (toast.isNotEmpty()) { delay(3000); toast = "" } }

    val items = trip?.contents.orEmpty()
    val item = items.firstOrNull { it.id == selected }

    suspend fun fetch(it: ContentItem): File {
        file?.takeIf { f -> f.first == it.id }?.let { return it.second }
        if (demo != null) return withContext(Dispatchers.IO) { Demo.video(context, it.id) }.also { f -> file?.second?.delete(); file = it.id to f }
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
    fun open(id: String) { if (selected != id) stop(); selected = id; page = ContentsPage.PLAYER; toast = "" }
    // C32 완성 표지에서 왔으면(ContentLink) 그 장면의 플레이어로 바로
    LaunchedEffect(trip) { val m = ContentLink.moment ?: return@LaunchedEffect; trip?.contents?.firstOrNull { it.momentId == m }?.let { ContentLink.moment = null; open(it.id) } }
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
            } catch (e: Exception) { toast = if (e is ApiError) "영상을 불러오지 못했어요. 기록 동의와 연결을 확인해 주세요" else e.message ?: "영상을 불러오지 못했어요" }
            finally { busy = false }
        }
    }
    // 틀(시안 C33–C38): 화면 제목(Title 40 · 12 · Label 24) · 24 · 본문 · 24 · 하단 작업(높이 96, 보기 화면은 숨김).
    Box(modifier) {
        Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(24.dp)) {
            val t = trip
            val none = loaded && (items.isEmpty() || t == null)
            val (title, sub) = when {
                !loaded -> "콘텐츠 기록" to ""
                none -> "콘텐츠 기록" to (t?.groupName?.takeIf { it.isNotBlank() }?.let { "$it / 차량과 폰에서 이어보기" } ?: "우리 가족 / 차량과 폰에서 이어보기")
                page == ContentsPage.PLAYER && item != null -> item.title to listOfNotNull("${monthDay(item.at)} ${hhmm(item.at)}", item.place).joinToString("  ")
                page == ContentsPage.EXPORT && item != null -> "영상이 준비됐어요" to "내 계정에 저장한 가족의 숏폼"
                page == ContentsPage.DETAIL -> "이 길에서 나눈 이야기" to "" // 시안 C36에는 부제 없음
                else -> "콘텐츠 기록" to "" // 보기 화면: 시안에서 부제는 숨김
            }
            TitleBlock(title, sub, Modifier.fillMaxWidth())
            val pickedId = (items.firstOrNull { t != null && contentSpot(it, t) != null } ?: items.firstOrNull())?.id // C36 '이 장면 보기' → 지도의 첫 장면(시안 → C37)
            Box(Modifier.weight(1f).fillMaxWidth()) {
                when {
                    !loaded -> {}
                    none -> Text(empty.ifBlank { "아직 생성한 콘텐츠가 없어요.\n여행을 마친 뒤 대화에서 장면을 골라 보세요." }, style = CarText.Headline, color = c.onSurfaceVariant)
                    page == ContentsPage.PLAYER && item != null -> PlayerBody(item, t!!, contentTint(items.indexOf(item)), position, playing, busy, player, ::toggle)
                    page == ContentsPage.EXPORT && item != null -> ExportBody(item, t!!, contentTint(items.indexOf(item)))
                    page == ContentsPage.DETAIL -> MapWithList(t!!, items, link = false, onOpen = ::open)
                    else -> Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(28.dp)) {
                        ViewSwitch(if (page in VIEWS.map { it.first }) page else ContentsPage.GALLERY) { page = it }
                        when (page) {
                            ContentsPage.TIMELINE -> Timeline(t!!, items, members, onFamily, ::open)
                            ContentsPage.MAP -> MapWithList(t!!, items, link = true, onOpen = ::open, onMore = { page = ContentsPage.DETAIL })
                            else -> Gallery(t!!, items, members, onFamily, ::open)
                        }
                    }
                }
            }
            // 하단 작업. 갤러리·타임라인·지도는 시안에서 숨김. 플레이어는 2026:3146('콘텐츠 기록' 440 + '영상 내보내기' 1138).
            when {
                !loaded -> {}
                none -> CarButton("함께 타는 중으로", onClick = onRide)
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
        CarToast(if (busy) "영상을 받고 있어요" else toast)
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
                            Column(Modifier.width(400.dp).clickable { onOpen(x.id) }, verticalArrangement = Arrangement.spacedBy(16.dp)) {
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

/**
 * C34 타임라인: 왼쪽 주행 정보(361) · 40 · 시간순 목록(간격 24). 오른쪽 열(148)에 시각: '출발'·'{장소} 도착' 줄은 글 왼쪽·시각 오른쪽(Label 24),
 * 장면 줄은 표지 104×143 · 24 · 제목(Headline 32)/장소/따옴표 줄(Label 24) · 오른쪽 열에 시각(Body 28)과 길이(22). 시안 2005:4522.
 */
@Composable
private fun Timeline(trip: ContentTrip, items: List<ContentItem>, members: Int, onFamily: () -> Unit, onOpen: (String) -> Unit) {
    val c = MaterialTheme.colorScheme
    @Composable
    fun Stop(label: String, at: Long) = Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(label, Modifier.weight(1f), style = CarText.Label, color = c.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(hhmm(at), Modifier.width(148.dp), style = CarText.Label, color = c.onSurfaceVariant, textAlign = TextAlign.End)
    }
    Row(Modifier.fillMaxSize().verticalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(40.dp)) {
        TripInfo(trip, members, onFamily, 361.dp)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(24.dp)) {
            trip.places.firstOrNull { it.kind == "start" }?.let { Stop("출발", it.at) }
            items.forEachIndexed { i, x ->
                Row(Modifier.fillMaxWidth().clickable { onOpen(x.id) }, horizontalArrangement = Arrangement.spacedBy(24.dp), verticalAlignment = Alignment.CenterVertically) {
                    ContentCover(coverOf(x, trip), contentTint(i), 104.dp, 143.dp)
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Text(x.title, style = CarText.Headline, color = c.onSurface, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        x.place?.let { Text(it, style = CarText.Label, color = c.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                        contentQuote(x)?.let { Text("“${it.text}”", style = CarText.Label, color = c.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                    }
                    Column(Modifier.width(148.dp), horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(hhmm(x.at), style = CarText.Body, color = c.onSurface)
                        Text(contentShortClock(x.seconds), style = CarText.Label.copy(fontSize = 22.sp, lineHeight = 30.sp), color = c.onSurfaceVariant)
                    }
                }
            }
            trip.places.lastOrNull { it.kind == "arrived" }?.let { Stop("${it.name.trim()} 도착", it.at) }
        }
    }
}

/** C37 플레이어 본문(가운데, 간격 64): 표지 playerCar 360×640(누르면 재생) · '이 장면의 대화'(620, 간격 28): '○○의 한마디', 따옴표 줄(Title 40), '09:32  동해고속도로', 재생 위치(620×4, line), 재생 글 단추. */
@Composable
private fun PlayerBody(item: ContentItem, trip: ContentTrip, tint: Int, position: Double, playing: Boolean, busy: Boolean, player: MediaPlayer?, onToggle: () -> Unit) {
    val c = MaterialTheme.colorScheme
    // 재생 전에는 장면을 남긴 순간의 줄(시안 '미리보기'), 재생을 시작한 뒤에는 지금 위치의 줄.
    val said = if (position > 0 || playing) contentLineAt(item, position) else contentQuote(item)
    Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(64.dp, Alignment.CenterHorizontally), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.clickable(enabled = !busy, onClick = onToggle)) {
            ContentCover(coverOf(item, trip), tint, 360.dp, 640.dp)
            // 재생을 시작하면 표지 자리에 쇼츠 영상을 그린다(오너 11/15: 누르면 쇼츠가 보이게). 소리만 있는 파일(영상 폭 0)은 표지 그대로.
            if (player != null && player.videoWidth > 0) AndroidView(
                factory = { ctx ->
                    TextureView(ctx).apply {
                        surfaceTextureListener = object : TextureView.SurfaceTextureListener {
                            override fun onSurfaceTextureAvailable(st: SurfaceTexture, w: Int, h: Int) { runCatching { player.setSurface(Surface(st)) } }
                            override fun onSurfaceTextureSizeChanged(st: SurfaceTexture, w: Int, h: Int) {}
                            override fun onSurfaceTextureDestroyed(st: SurfaceTexture): Boolean { runCatching { player.setSurface(null) }; return true }
                            override fun onSurfaceTextureUpdated(st: SurfaceTexture) {}
                        }
                    }
                },
                modifier = Modifier.size(360.dp, 640.dp).clip(RoundedCornerShape(22.5.dp)), // 표지와 같은 모서리(25 × 360/400)
            )
        }
        Column(Modifier.width(620.dp), verticalArrangement = Arrangement.spacedBy(28.dp)) {
            Text(said?.name?.takeIf { it.isNotBlank() }?.let { "${it}의 한마디" } ?: "이 장면의 한마디", style = CarText.Label, color = c.onSurfaceVariant)
            Text("“${said?.text ?: item.title}”", style = CarText.Title, color = c.onSurface)
            Text(listOfNotNull(hhmm(item.at), item.place).joinToString("  "), style = CarText.Label, color = c.onSurfaceVariant)
            Box(Modifier.fillMaxWidth().height(4.dp).background(c.outlineVariant))
            val label = when { playing -> "Ⅱ  일시정지"; position > 0 -> "▶  이어서 재생"; else -> "▶  미리보기 재생" }
            Text("$label   ${contentShortClock(position)} / ${contentShortClock(item.seconds)}", Modifier.clickable(enabled = !busy, onClick = onToggle),
                style = CarText.Label, color = c.onSurface)
        }
    }
}

/** C38 내보내기 본문(가운데, 간격 64): 표지 360×640(시안처럼 누름 없음) · '내보내기 정보'(700, 간격 24). 저장·공유는 폰의 콘텐츠 기록에서. */
@Composable
private fun ExportBody(item: ContentItem, trip: ContentTrip, tint: Int) {
    val c = MaterialTheme.colorScheme
    Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(64.dp, Alignment.CenterHorizontally), verticalAlignment = Alignment.CenterVertically) {
        ContentCover(coverOf(item, trip), tint, 360.dp, 640.dp)
        Column(Modifier.width(700.dp), verticalArrangement = Arrangement.spacedBy(24.dp)) {
            Text(item.title, style = CarText.Title, color = c.onSurface)
            // mock: 형식 글(MP4 · 9:16)은 서버 파일 검사가 지키는 값이라 시안 글 그대로, 길이만 데이터.
            Text("MP4  /  9:16  /  ${item.seconds.toInt()}초", style = CarText.Label, color = c.onSurfaceVariant)
            Text("캐릭터와 우리 목소리 그대로", style = CarText.Body, color = c.onSurface)
            Text("내 계정의 콘텐츠 기록에서\n폰으로 저장하고 공유할 수 있어요.", style = CarText.Label, color = c.onSurfaceVariant)
        }
    }
}

/**
 * C35 지도·C36 상세 '실제 지도와 장면': 지도(1080×660, 남는 폭) · 28 · '지도 속 장면 목록'(494, 간격 16): '11월 14일'(Label 24), 여행 제목(Title 40), 장소 줄,
 * 장면 링크(표지 62×85 · 16 · 제목 두 줄 Body 28 · 오른쪽에 '09:32  0:32'), 지도 화면만 '주행 지도 자세히 보기 →'.
 * 지도 액자와 장면 링크는 둘 다 그 장면의 플레이어로 간다(시안 '지도 장면 1 → C37', '장면 링크 3 → player3').
 */
@Composable
private fun MapWithList(trip: ContentTrip, items: List<ContentItem>, link: Boolean, onOpen: (String) -> Unit, onMore: () -> Unit = {}) {
    val c = MaterialTheme.colorScheme
    val (start, _) = contentTripRange(trip)
    Row(Modifier.fillMaxWidth().heightIn(max = 660.dp), horizontalArrangement = Arrangement.spacedBy(28.dp)) {
        MapBox(trip, items, Modifier.weight(1f).fillMaxHeight(), onOpen)
        Column(Modifier.width(494.dp).fillMaxHeight().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Text(monthDay(start), style = CarText.Label, color = c.onSurfaceVariant)
            Text(trip.title.ifBlank { "함께 탄 여행" }, style = CarText.Title, color = c.onSurface)
            contentPlaceChain(trip.places).takeIf { it.isNotBlank() }?.let { Text(it, style = CarText.Label, color = c.onSurfaceVariant) }
            items.forEachIndexed { i, x ->
                Row(Modifier.fillMaxWidth().clickable { onOpen(x.id) }, horizontalArrangement = Arrangement.spacedBy(16.dp), verticalAlignment = Alignment.CenterVertically) {
                    ContentCover(coverOf(x, trip), contentTint(i), 62.dp, 85.dp)
                    Text(contentTwoLines(x.title), Modifier.weight(1f), style = CarText.Body, color = c.onSurface, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    Text("${hhmm(x.at)}  ${contentShortClock(x.seconds)}", style = CarText.Label, color = c.onSurfaceVariant, maxLines = 1)
                }
            }
            if (link) LinkText("주행 지도 자세히 보기 →", onMore)
        }
    }
}

/** 시안 지도 그림의 색(Material 역할에 없는 값): 길 'Frame' 벡터의 흰 테두리 12·초록 6, 출처 글. 공통으로 올릴 때는 CarDesign.kt(F3). */
private object MapInk {
    val Halo = Color(0xFFFFFFFF)
    val Route = Color(0xFF20775B)
    val Credit = Color(0xFF262626)
}

/**
 * 지도 상자(모서리 24). 기록 좌표가 번들 실제 지도(BUNDLED_MAPS: 강릉, 강남–분당) 안이면 그 그림(Crop) 위에, 아니면 surface-2 바탕 위에 투영한다.
 * 장면 액자: 'Archive / pin'(88, 바탕 bg, 모서리 16, 안쪽 4, 표지 윗부분이 보임). 액자 아래 가운데가 그 장면 자리(contentSpot).
 * 출처 '© OpenStreetMap contributors'(시안 Pretendard 13/18, 왼쪽 10·아래 4).
 */
@Composable
private fun MapBox(trip: ContentTrip, items: List<ContentItem>, modifier: Modifier, onPin: (String) -> Unit) {
    val c = MaterialTheme.colorScheme
    BoxWithConstraints(modifier.clip(CarShape.Ctl).background(c.surfaceVariant)) {
        val density = LocalDensity.current
        val w = with(density) { maxWidth.toPx() }; val h = with(density) { maxHeight.toPx() }
        val spots = items.mapNotNull { x -> contentSpot(x, trip)?.let { x to it } }
        val (start, finish) = contentEnds(trip)
        val ends = listOfNotNull(start, finish)
        val points = trip.route + spots.map { it.second } + ends.map { it.lat!! to it.lng!! }
        val real = contentBundledMap(points)
        val project = if (real != null) contentOsmProjector(real, w, h) else contentProjector(points, w, h, with(density) { 120.dp.toPx() })
        if (real != null) Image(painterResource(real.res), real.label, Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
        Canvas(Modifier.fillMaxSize()) {
            if (project != null && trip.route.size > 1) {
                val path = Path().apply { trip.route.forEachIndexed { i, p -> val o = project(p); if (i == 0) moveTo(o.x, o.y) else lineTo(o.x, o.y) } }
                drawPath(path, MapInk.Halo, style = Stroke(12.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round))
                drawPath(path, MapInk.Route, style = Stroke(6.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round))
            }
            if (project != null) {
                // 받은 경로가 없으면 출발→도착을 점선(추정, 길을 지어내지 않음)으로 잇는다
                if (trip.route.size < 2 && start != null && finish != null) {
                    val p0 = project(start.lat!! to start.lng!!); val p1 = project(finish.lat!! to finish.lng!!)
                    drawLine(MapInk.Halo, p0, p1, 10.dp.toPx(), StrokeCap.Round)
                    drawLine(MapInk.Route, p0, p1, 5.dp.toPx(), StrokeCap.Round, PathEffect.dashPathEffect(floatArrayOf(14.dp.toPx(), 10.dp.toPx())))
                }
                ends.forEach { e -> val o = project(e.lat!! to e.lng!!); drawCircle(MapInk.Halo, 12.dp.toPx(), o); drawCircle(MapInk.Route, 8.dp.toPx(), o) }
            }
        }
        // 출발·도착 이름(시안 밖: 경로를 받지 못한 여행도 어디서 어디로 갔는지 보이게). 흰 바탕 작은 글
        project?.let { pr -> ends.forEach { e ->
            val o = pr(e.lat!! to e.lng!!)
            Text(e.name, Modifier.offset(with(density) { (o.x + 14.dp.toPx()).coerceIn(0f, maxOf(0f, w - 160.dp.toPx())).toDp() }, with(density) { (o.y - 14.dp.toPx()).coerceIn(0f, maxOf(0f, h - 28.dp.toPx())).toDp() })
                .background(MapInk.Halo, RoundedCornerShape(8.dp)).padding(horizontal = 8.dp, vertical = 2.dp),
                style = TextStyle(fontFamily = Pretendard, fontSize = 18.sp, lineHeight = 24.sp), color = MapInk.Credit, maxLines = 1)
        } }
        project?.let { pr -> spots.forEach { (x, spot) ->
            val o = pr(spot)
            val dx = with(density) { (o.x - 44.dp.toPx()).coerceIn(0f, (w - 88.dp.toPx()).coerceAtLeast(0f)).toDp() }
            val dy = with(density) { (o.y - 88.dp.toPx()).coerceIn(0f, (h - 88.dp.toPx()).coerceAtLeast(0f)).toDp() }
            Surface(onClick = { onPin(x.id) }, shape = CarShape.Tab, color = c.background, modifier = Modifier.offset(dx, dy).size(88.dp)) {
                Box(Modifier.padding(4.dp).clip(RoundedCornerShape(4.5.dp))) {
                    Box(Modifier.wrapContentHeight(Alignment.Top, unbounded = true)) { ContentCover(coverOf(x, trip), contentTint(items.indexOf(x)), 80.dp, 110.dp) }
                }
            }
        } }
        if (real != null) Text("© OpenStreetMap contributors", Modifier.align(Alignment.BottomStart).padding(start = 10.dp, bottom = 4.dp),
            style = TextStyle(fontFamily = Pretendard, fontSize = 13.sp, lineHeight = 18.sp), color = MapInk.Credit)
    }
}
