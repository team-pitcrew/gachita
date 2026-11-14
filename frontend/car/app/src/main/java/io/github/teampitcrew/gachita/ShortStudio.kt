package io.github.teampitcrew.gachita

import android.content.ClipData
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Environment
import android.provider.MediaStore
import android.widget.VideoView
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import kotlinx.coroutines.*
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean

private enum class ShortsPage { FEED, LIBRARY, CREATE, CONFIRM, PROGRESS }
private val ShortButtonShape = RoundedCornerShape(10.dp)
private val MediaBackground = Color(0xFF12110F)
private val MediaInk = Color(0xFFF4F1EC)
private val MediaSecondary = Color(0xFFB5ADA2)
private data class FeedShort(val key: String, val title: String, val durationMs: Long, val whenMs: Long, val stored: LibraryShort? = null, val job: JSONObject? = null)

/** 피드는 완성된 MP4만, 제작 설정은 별도 화면에서 다룹니다. */
@Composable
internal fun ShortStudio(base: String, code: String, generation: Int, token: String?, tripTitle: String,
    canRead: () -> Boolean, canPlay: () -> Boolean, onClose: () -> Unit, onLocal: () -> Unit,
    onActiveChange: (Boolean) -> Unit, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val remoteAccess by rememberUpdatedState(canRead)
    val playbackAccess by rememberUpdatedState(canPlay)
    val activeChange by rememberUpdatedState(onActiveChange)
    val api = remember(base) { Server(base) }
    val scope = rememberCoroutineScope()
    val alive = remember { AtomicBoolean(true) }
    val enteringLocal = remember { AtomicBoolean(false) }
    val prefs = remember { context.getSharedPreferences("short-generation", Context.MODE_PRIVATE) }
    val pendingKey = remember { "$code:$generation:" + java.security.MessageDigest.getInstance("SHA-256").digest("$base|$token".toByteArray()).joinToString("") { "%02x".format(it) } }
    var pending by remember { mutableStateOf(prefs.getString(pendingKey, null)?.let { runCatching { JSONObject(it) }.getOrNull() }) }
    var catalog by remember { mutableStateOf<JSONObject?>(null) }
    var jobs by remember { mutableStateOf<List<JSONObject>>(emptyList()) }
    var library by remember { mutableStateOf<List<LibraryShort>>(emptyList()) }
    var page by remember { mutableStateOf(ShortsPage.FEED) }
    var plan by remember { mutableStateOf<JSONObject?>(null) }
    var template by remember { mutableStateOf(pending?.optString("templateId") ?: "car-sitcom-v1") }
    var audio by remember { mutableStateOf(pending?.optBoolean("audioReference") ?: false) }
    var expanded by remember { mutableStateOf(false) }
    var options by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var loading by remember { mutableStateOf(true) }
    var note by remember { mutableStateOf("") }
    var query by remember { mutableStateOf("") }
    var deleting by remember { mutableStateOf<LibraryShort?>(null) }
    var selectedKey by remember { mutableStateOf<String?>(null) }
    var currentUri by remember { mutableStateOf<Uri?>(null) }
    var loadedKey by remember { mutableStateOf<String?>(null) }
    var currentJob by remember { mutableStateOf<JSONObject?>(null) }
    var playing by remember { mutableStateOf(false) }
    var muted by remember { mutableStateOf(false) }
    var player by remember { mutableStateOf<android.media.MediaPlayer?>(null) }
    var position by remember { mutableStateOf(0L) }
    var savedUri by remember { mutableStateOf<Uri?>(null) }
    val video = remember { VideoView(context) }
    val cache = remember { mutableMapOf<String, File>() }
    val thumbs = remember { mutableStateMapOf<String, Bitmap>() }
    val completed = jobs.filter { it.optString("state") == "completed" }
    val savedUris = library.map { it.uri.toString() }.toSet()
    val feed = (completed.filterNot { prefs.getString("saved:${it.getString("id")}", null) in savedUris }.map { j ->
        FeedShort("job:${j.getString("id")}", prefs.getString("title:${j.getString("id")}", null) ?: tripTitle.ifBlank { "함께 남긴 대화" },
            (j.getJSONObject("result").getDouble("seconds") * 1000).toLong(), runCatching { java.time.Instant.parse(j.getString("createdAt")).toEpochMilli() }.getOrDefault(0), job = j)
    } + library.map { FeedShort(it.uri.toString(), it.title, it.durationMs, it.savedAt, stored = it) }).sortedByDescending { it.whenMs }
    val selected = feed.find { it.key == selectedKey } ?: feed.firstOrNull()
    fun checkLocal() { check(alive.get() && playbackAccess()) { "주차한 뒤 쇼츠를 확인해 주세요" } }
    fun checkRemote() { checkLocal(); check(token != null && remoteAccess()) { "모두의 기록 동의와 연결을 확인해 주세요" } }
    suspend fun <T> io(remote: Boolean = true, block: () -> T): T = withContext(Dispatchers.IO) {
        if (remote) checkRemote() else checkLocal()
        block().also { if (remote) checkRemote() else checkLocal() }
    }
    fun clearVideo() { video.stopPlayback(); video.tag = null; playing = false; currentUri = null; loadedKey = null; currentJob = null; savedUri = null; position = 0 }
    fun perform(block: suspend () -> Unit) {
        if (busy) return
        busy = true; note = ""
        scope.launch {
            try { checkLocal(); block() }
            catch (e: CancellationException) { throw e }
            catch (e: Exception) { note = e.message ?: "연결을 다시 확인해 주세요"; if (e is ApiError && e.status in listOf(401, 403, 404, 409, 410)) { plan = null; clearVideo() } }
            finally { busy = false }
        }
    }
    fun array(a: JSONArray) = (0 until a.length()).map(a::getJSONObject)
    suspend fun refreshJobs() { if (token != null && remoteAccess()) jobs = array(io { api.shortJobs(code, token) }) else jobs = emptyList() }
    suspend fun refreshLibrary() { library = io(false) { storedShorts(context) } }
    suspend fun previewPlan() { plan = null; plan = io { api.shortPlan(code, requireNotNull(token), template, audio).also { require(it.getInt("generation") == generation) } } }
    fun rememberPending(value: JSONObject?) {
        check(prefs.edit().apply { if (value == null) remove(pendingKey) else putString(pendingKey, value.toString()) }.commit()) { "제작 요청을 보관하지 못했어요" }
        pending = value
    }
    fun openCreate() { if (busy) return; video.pause(); playing = false; page = ShortsPage.CREATE; if (plan == null && pending == null && remoteAccess()) perform { previewPlan() } }
    fun move(step: Int) {
        if (busy) return
        val at = feed.indexOfFirst { it.key == selected?.key }
        feed.getOrNull(at + step)?.let { clearVideo(); selectedKey = it.key }
    }
    fun share(uri: Uri) {
        context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).apply {
            type = "video/mp4"; putExtra(Intent.EXTRA_STREAM, uri); clipData = ClipData.newRawUri("가치타 쇼츠", uri); addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }, "쇼츠 공유"))
    }
    suspend fun saveCurrent(): Uri {
        val item = requireNotNull(selected)
        check(loadedKey == item.key) { "영상이 준비된 뒤 다시 시도해 주세요" }
        savedUri?.let { return it }
        item.stored?.let { savedUri = it.uri; return it.uri }
        val job = requireNotNull(currentJob)
        check(item.job?.getString("id") == job.getString("id")) { "영상이 준비된 뒤 다시 시도해 주세요" }
        val file = requireNotNull(cache[job.getString("id")])
        val uri = io {
            api.completedShortJob(code, requireNotNull(token), job.getString("id"))
            val resolver = context.contentResolver
            val target = requireNotNull(resolver.insert(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, ContentValues().apply {
                put(MediaStore.Video.Media.DISPLAY_NAME, "가치타_${UUID.randomUUID()}.mp4"); put(MediaStore.Video.Media.TITLE, item.title)
                put(MediaStore.Video.Media.MIME_TYPE, "video/mp4"); put(MediaStore.Video.Media.RELATIVE_PATH, "${Environment.DIRECTORY_MOVIES}/Gachita"); put(MediaStore.Video.Media.IS_PENDING, 1)
            }))
            try {
                requireNotNull(resolver.openOutputStream(target)).use { out -> file.inputStream().use { it.copyTo(out) } }
                api.completedShortJob(code, token, job.getString("id")); checkRemote()
                check(resolver.update(target, ContentValues().apply { put(MediaStore.Video.Media.IS_PENDING, 0) }, null, null) == 1)
                target
            } catch (e: Exception) { resolver.delete(target, null, null); throw e }
        }
        prefs.edit().putString("saved:${job.getString("id")}", uri.toString()).apply()
        savedUri = uri
        refreshLibrary()
        selectedKey = uri.toString()
        return uri
    }
    BackHandler { if (!busy) { if (page == ShortsPage.FEED) onClose() else { page = ShortsPage.FEED; note = "" } } }
    DisposableEffect(Unit) {
        activeChange(true)
        CaptureService.hold(true)
        video.setOnPreparedListener { media -> player = media; media.isLooping = true; media.setVolume(if (muted) 0f else 1f, if (muted) 0f else 1f); if (page == ShortsPage.FEED && playbackAccess()) { video.start(); playing = true } else video.seekTo(1) }
        video.setOnErrorListener { _, _, _ -> playing = false; note = "영상을 재생하지 못했어요. 다른 쇼츠를 선택한 뒤 다시 열어 주세요."; true }
        onDispose { alive.set(false); video.stopPlayback(); cache.values.forEach { it.delete() }; thumbs.clear(); if (!enteringLocal.get()) CaptureService.hold(false); activeChange(false) }
    }
    LaunchedEffect(Unit) {
        try {
            refreshLibrary()
            if (remoteAccess()) coroutineScope {
                val templates = async { io { api.shortTemplates() } }
                refreshJobs(); catalog = templates.await()
            }
        } catch (e: CancellationException) { throw e } catch (e: Exception) { note = e.message ?: "연결을 확인해 주세요" } finally { loading = false }
        while (isActive) {
            delay(5000)
            if (!playbackAccess()) { onClose(); break }
            if (!busy && remoteAccess()) try {
                refreshJobs()
                currentJob?.let { io { api.completedShortJob(code, requireNotNull(token), it.getString("id")) } }
            } catch (e: CancellationException) { throw e } catch (e: Exception) { if (currentJob != null) clearVideo(); note = e.message ?: "연결을 확인해 주세요" }
        }
    }
    LaunchedEffect(selected?.key, page == ShortsPage.FEED) {
        if (page != ShortsPage.FEED || selected == null) { video.pause(); playing = false; return@LaunchedEffect }
        clearVideo()
        try {
            val uri = selected.stored?.uri ?: selected.job?.let { job ->
                val id = job.getString("id")
                val file = cache[id] ?: File.createTempFile("short-generated-", ".mp4", context.cacheDir).also { file ->
                    try { io { api.downloadShort(generationFile(base, code, job), requireNotNull(token), file, { !alive.get() }, {}, maxBytes = 100_000_000, mimeType = "video/mp4"); api.completedShortJob(code, token, id) }; cache[id] = file }
                    catch (e: Exception) { file.delete(); throw e }
                }
                io { api.completedShortJob(code, requireNotNull(token), id) }
                currentJob = job
                Uri.fromFile(file)
            }
            checkLocal(); currentUri = uri; loadedKey = selected.key; savedUri = selected.stored?.uri
            if (uri != null && !thumbs.containsKey(selected.key)) io(false) { shortThumbnail(context, uri) }?.let { thumbs[selected.key] = it }
        } catch (e: CancellationException) { throw e } catch (e: Exception) { note = e.message ?: "영상을 불러오지 못했어요" }
    }
    LaunchedEffect(remoteAccess()) {
        if (!remoteAccess() && currentJob != null) { clearVideo(); note = "연결과 기록 동의를 다시 확인해 주세요" }
    }
    LaunchedEffect(playbackAccess()) {
        if (!playbackAccess()) { clearVideo(); onClose() }
    }
    LaunchedEffect(playing, currentUri) { while (playing) { position = video.currentPosition.toLong(); delay(250) } }
    deleting?.let { item ->
        AlertDialog(onDismissRequest = { if (!busy) deleting = null }, shape = ShortButtonShape,
            title = { Text("이 기기의 영상을 삭제할까요?") },
            text = { Text("${item.title}\n갤러리와 보관함에서 삭제되며 되돌릴 수 없어요.") },
            dismissButton = { TextButton(onClick = { deleting = null }, enabled = !busy, shape = ShortButtonShape) { Text("취소") } },
            confirmButton = { TextButton(onClick = { perform {
                if (currentUri == item.uri) clearVideo()
                val removed = io(false) { context.contentResolver.delete(item.uri, null, null) }
                check(removed == 1) { "영상을 삭제하지 못했어요" }
                deleting = null; thumbs.remove(item.uri.toString()); refreshLibrary(); note = "기기에서 삭제했어요"
            } }, enabled = !busy, shape = ShortButtonShape) { Text("삭제", color = MaterialTheme.colorScheme.error) } })
    }

    val dark = page == ShortsPage.FEED
    val ink = if (dark) MediaInk else MaterialTheme.colorScheme.onSurface
    Column(modifier.background(if (dark) MediaBackground else MaterialTheme.colorScheme.background)) {
        ShortStudioHeader(page, busy, code.isBlank(), ink, onClose,
            onFeed = { if (!busy) { page = ShortsPage.FEED; note = "" } },
            onLibrary = { if (!busy) { page = ShortsPage.LIBRARY; video.pause(); playing = false; note = ""; perform { refreshLibrary(); refreshJobs() } } },
            onCreate = ::openCreate,
            onBack = { if (!busy) page = if (page == ShortsPage.CONFIRM) ShortsPage.CREATE else ShortsPage.FEED })
        if (note.isNotBlank()) Text(note, color = ink, fontSize = 18.sp, modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp))
        when (page) {
            ShortsPage.FEED -> ShortFeedPage(feed, selected, loading, busy, video, currentUri, playing, savedUri != null, muted, position,
                onCreate = ::openCreate,
                onToggle = { if (video.isPlaying) { video.pause(); playing = false } else { video.start(); playing = true } },
                onSave = { perform { saveCurrent(); note = "이 기기 보관함에 저장했어요" } },
                onShare = { perform {
                    val jobId = currentJob?.getString("id")
                    val uri = saveCurrent()
                    if (jobId != null) io { api.completedShortJob(code, requireNotNull(token), jobId) }
                    checkLocal(); share(uri)
                } },
                onMute = { muted = !muted; val volume = if (muted) 0f else 1f; runCatching { player?.setVolume(volume, volume) } },
                onMove = ::move, modifier = Modifier.weight(1f).fillMaxWidth())
            ShortsPage.LIBRARY -> ShortLibraryPage(feed, jobs, thumbs, busy, query,
                onQuery = { query = it },
                onCancel = { job -> perform { io { api.cancelShortJob(code, requireNotNull(token), job.getString("id")) }; refreshJobs() } },
                onSelect = { item -> if (!busy) { clearVideo(); selectedKey = item.key; page = ShortsPage.FEED; note = "" } },
                onDelete = { if (!busy) deleting = it }, modifier = Modifier.weight(1f).fillMaxWidth())
            ShortsPage.CREATE, ShortsPage.CONFIRM, ShortsPage.PROGRESS -> ShortCreationPage(page,
                ShortCreationUi(catalog, plan, pending != null, template, audio, expanded, options, busy, remoteAccess()),
                onLibrary = { if (!busy) page = ShortsPage.LIBRARY },
                onSubmit = { perform {
                    checkRemote()
                    val confirmedPlan = plan
                    val request = pending ?: confirmedPlan?.let { generationRequest(it, UUID.randomUUID().toString(), true) }
                        ?: error("장면 구성을 다시 확인해 주세요")
                    if (pending == null) rememberPending(request)
                    try {
                        val job = io { api.createShortJob(code, requireNotNull(token), request) }
                        confirmedPlan?.optString("title")?.let { prefs.edit().putString("title:${job.getString("id")}", it).apply() }
                        rememberPending(null); plan = null; jobs = listOf(job) + jobs.filter { it.getString("id") != job.getString("id") }; page = ShortsPage.PROGRESS
                    } catch (e: ApiError) { if (e.status in 400..499) { rememberPending(null); plan = null; page = ShortsPage.CREATE }; throw e }
                } },
                onTemplate = { template = it; perform { previewPlan() } },
                onExpand = { expanded = !expanded }, onOptions = { options = !options },
                onAudio = { audio = it; perform { previewPlan() } },
                onReview = { page = ShortsPage.CONFIRM },
                onLocal = { enteringLocal.set(true); CaptureService.hold(false); onLocal() },
                onRecommend = { perform { previewPlan() } }, modifier = Modifier.weight(1f).fillMaxWidth())
        }
    }
}

@Composable
private fun ShortStudioHeader(page: ShortsPage, busy: Boolean, showClose: Boolean, ink: Color,
    onClose: () -> Unit, onFeed: () -> Unit, onLibrary: () -> Unit, onCreate: () -> Unit, onBack: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        if (page in listOf(ShortsPage.FEED, ShortsPage.LIBRARY)) {
            if (showClose) TextButton(onClick = { if (!busy) onClose() }, enabled = !busy, shape = ShortButtonShape) { Text("뒤로", color = ink, fontSize = 20.sp) }
            TextButton(onClick = onFeed, enabled = !busy, shape = ShortButtonShape) { Text("쇼츠", color = ink.copy(alpha = if (page == ShortsPage.FEED) 1f else .55f), fontSize = 25.sp, fontWeight = FontWeight.Bold) }
            TextButton(onClick = onLibrary, enabled = !busy, shape = ShortButtonShape) { Text("보관함", color = ink.copy(alpha = if (page == ShortsPage.LIBRARY) 1f else .55f), fontSize = 25.sp, fontWeight = FontWeight.Bold) }
            Spacer(Modifier.weight(1f))
            OutlinedButton(onClick = onCreate, shape = ShortButtonShape, enabled = !busy) { Text("+ 만들기", color = ink, fontSize = 20.sp) }
        } else {
            TextButton(onClick = onBack, enabled = !busy, shape = ShortButtonShape) { Text("뒤로", fontSize = 22.sp) }
            Text(when (page) { ShortsPage.CREATE -> "새 쇼츠"; ShortsPage.CONFIRM -> "제작 확인"; else -> "제작 중" }, fontSize = 26.sp, fontWeight = FontWeight.Bold)
        }
    }
}

@Composable
private fun ShortFeedPage(feed: List<FeedShort>, selected: FeedShort?, loading: Boolean, busy: Boolean,
    video: VideoView, currentUri: Uri?, playing: Boolean, saved: Boolean, muted: Boolean, position: Long,
    onCreate: () -> Unit, onToggle: () -> Unit, onSave: () -> Unit, onShare: () -> Unit,
    onMute: () -> Unit, onMove: (Int) -> Unit, modifier: Modifier) {
    val move by rememberUpdatedState(onMove)
    Box(modifier) {
        if (selected == null) Column(Modifier.align(Alignment.Center).padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Text(if (loading) "쇼츠를 불러오고 있어요" else "첫 쇼츠를 남겨보세요", fontSize = 30.sp, color = MediaInk, fontWeight = FontWeight.Bold)
            if (!loading) { Text("함께 나눈 대화를 짧은 영상으로", color = MediaSecondary, fontSize = 22.sp); Button(onClick = onCreate, enabled = !busy, shape = ShortButtonShape) { Text("새 쇼츠 만들기", fontSize = 22.sp) } }
        } else {
            var drag by remember { mutableStateOf(0f) }
            BoxWithConstraints(Modifier.fillMaxSize().padding(bottom = 78.dp)) {
                val width = minOf(maxWidth, maxHeight * 9 / 16)
                Box(Modifier.width(width).fillMaxHeight().align(Alignment.Center)) {
                    currentUri?.let { uri -> AndroidView(factory = { video }, update = { if (video.tag != uri.toString()) { video.tag = uri.toString(); video.setVideoURI(uri) } }, modifier = Modifier.fillMaxSize()) }
                    Box(Modifier.fillMaxSize().semantics { contentDescription = "${selected.title}, ${shortDuration(selected.durationMs)}. 위아래로 넘기는 쇼츠" }
                        .clickable(enabled = currentUri != null, onClick = onToggle)
                        .pointerInput(feed.map { it.key }, selected.key) { detectVerticalDragGestures(onDragStart = { drag = 0f }, onVerticalDrag = { change, amount -> change.consume(); drag += amount }, onDragEnd = { if (drag < -70) move(1) else if (drag > 70) move(-1) }) })
                    if (currentUri == null) Text("영상 불러오는 중", color = MediaInk, modifier = Modifier.align(Alignment.Center))
                }
            }
            Column(Modifier.align(Alignment.CenterEnd).padding(end = 10.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
                MediaAction(if (playing) "일시정지" else "재생", if (playing) "pause" else "play", currentUri != null, onClick = onToggle)
                MediaAction(if (saved) "저장됨" else "저장", "save", currentUri != null && !busy && !saved, onClick = onSave)
                MediaAction("공유", "share", currentUri != null && !busy, onClick = onShare)
                MediaAction(if (muted) "소리 켬" else "음소거", "sound", currentUri != null, onClick = onMute)
            }
            Column(Modifier.align(Alignment.BottomStart).fillMaxWidth().padding(start = 20.dp, end = 20.dp, bottom = 10.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                Text(selected.title, fontSize = 24.sp, color = MediaInk, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text("${shortDuration(position)} / ${shortDuration(selected.durationMs)}", color = MediaSecondary, fontSize = 18.sp)
                    Spacer(Modifier.weight(1f))
                    TextButton(onClick = { move(-1) }, enabled = !busy && feed.indexOf(selected) > 0, shape = ShortButtonShape) { Text("이전", color = MediaSecondary, fontSize = 20.sp) }
                    TextButton(onClick = { move(1) }, enabled = !busy && feed.indexOf(selected) < feed.lastIndex, shape = ShortButtonShape) { Text("다음", color = MediaSecondary, fontSize = 20.sp) }
                }
            }
        }
    }
}

@Composable
private fun ShortLibraryPage(feed: List<FeedShort>, jobs: List<JSONObject>, thumbs: MutableMap<String, Bitmap>,
    busy: Boolean, query: String, onQuery: (String) -> Unit, onCancel: (JSONObject) -> Unit,
    onSelect: (FeedShort) -> Unit, onDelete: (LibraryShort) -> Unit, modifier: Modifier) {
    val filtered = feed.filter { it.title.contains(query, ignoreCase = true) }
    Column(modifier.padding(horizontal = 18.dp)) {
        OutlinedTextField(value = query, onValueChange = onQuery, placeholder = { Text("쇼츠 제목 검색") }, singleLine = true, shape = ShortButtonShape, modifier = Modifier.fillMaxWidth())
        LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(16.dp), contentPadding = PaddingValues(vertical = 16.dp)) {
            val unfinished = jobs.filter { it.optString("state") != "completed" }
            if (unfinished.isNotEmpty()) item {
                Text("이번 여행 · 제작 상태", fontSize = 22.sp, fontWeight = FontWeight.Bold)
                unfinished.forEach { job -> Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(generationLabel(job), fontSize = 18.sp, modifier = Modifier.weight(1f))
                    if (generationActive(job)) TextButton(onClick = { onCancel(job) }, enabled = !busy, shape = ShortButtonShape) { Text("취소", fontSize = 20.sp) }
                } }
            }
            if (filtered.isEmpty()) item { Text(if (query.isBlank()) "아직 보관한 쇼츠가 없어요" else "검색 결과가 없어요", fontSize = 24.sp, modifier = Modifier.padding(vertical = 32.dp)) }
            items(filtered.chunked(3)) { row -> Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
                row.forEach { item -> ShortTile(item, thumbs[item.key], Modifier.weight(1f), enabled = !busy, onBitmap = { thumbs[item.key] = it }, onClick = { onSelect(item) }, onDelete = onDelete) }
                repeat(3 - row.size) { Spacer(Modifier.weight(1f)) }
            } }
            item { Text("이 기기에 저장한 영상은 여행이 끝나도 남아요. 다른 기기와 자동으로 동기화하지 않아요.", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 18.sp) }
        }
    }
}

private data class ShortCreationUi(val catalog: JSONObject?, val plan: JSONObject?, val hasPending: Boolean,
    val template: String, val audio: Boolean, val expanded: Boolean, val options: Boolean, val busy: Boolean, val remote: Boolean)

private fun jsonObjects(array: JSONArray) = (0 until array.length()).map(array::getJSONObject)

@Composable
private fun ShortCreationPage(page: ShortsPage, ui: ShortCreationUi, onLibrary: () -> Unit, onSubmit: () -> Unit,
    onTemplate: (String) -> Unit, onExpand: () -> Unit, onOptions: () -> Unit, onAudio: (Boolean) -> Unit,
    onReview: () -> Unit, onLocal: () -> Unit, onRecommend: () -> Unit, modifier: Modifier) {
    Column(modifier.verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
        if (page == ShortsPage.PROGRESS) {
            Text("우리의 대화를 영상으로 만들고 있어요", fontSize = 30.sp, fontWeight = FontWeight.Bold)
            Text("화면을 닫아도 제작은 이어져요.", fontSize = 22.sp)
            Button(onClick = onLibrary, enabled = !ui.busy, shape = ShortButtonShape) { Text("보관함으로", fontSize = 22.sp) }
        } else if (page == ShortsPage.CONFIRM) {
            Text(ui.plan?.optString("title") ?: "이전 제작 요청", fontSize = 30.sp, fontWeight = FontWeight.Bold)
            Text("Higgsfield에 보내는 자료", fontSize = 22.sp, fontWeight = FontWeight.Medium)
            val externalData = ui.plan?.optJSONArray("externalData")
            Text(if (externalData != null) (0 until externalData.length()).joinToString(" · ") { externalData.getString(it) } else "선택 캐릭터 이미지 · 발화 시각과 반응 지시${if (ui.audio) " · 장면별 원음" else ""}", fontSize = 22.sp)
            Text("최종 영상에는 원래 목소리와 자막이 들어가요.", fontSize = 20.sp)
            Text("직접 저장한 영상은 기록 동의를 꺼도 기기에 남아요.", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 20.sp)
            Button(enabled = !ui.busy && ui.remote && ui.catalog?.optBoolean("enabled") == true && (ui.plan != null || ui.hasPending), shape = ShortButtonShape, modifier = Modifier.fillMaxWidth().heightIn(min = 64.dp), onClick = onSubmit) { Text(if (!ui.hasPending) "동의하고 만들기" else "동의하고 접수 확인", fontSize = 24.sp) }
        } else {
            Text("어떤 이야기로 남길까요?", fontSize = 28.sp, fontWeight = FontWeight.Bold)
            ui.catalog?.getJSONArray("templates")?.let { ts -> Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) { jsonObjects(ts).forEach { t ->
                val chosen = ui.template == t.getString("id")
                OutlinedButton(onClick = { onTemplate(t.getString("id")) }, enabled = !ui.busy && !ui.hasPending, shape = ShortButtonShape, colors = ButtonDefaults.outlinedButtonColors(containerColor = if (chosen) MaterialTheme.colorScheme.onSurface else Color.Transparent, contentColor = if (chosen) MaterialTheme.colorScheme.surface else MaterialTheme.colorScheme.onSurface), modifier = Modifier.weight(1f)) { Text(t.getString("name"), fontSize = 22.sp) }
            } } }
            ui.plan?.let { p ->
                Text(p.getString("title"), fontSize = 27.sp, fontWeight = FontWeight.Bold)
                Text("${p.getDouble("seconds").toInt()}초 · ${p.getJSONArray("shots").length()}개 장면 · 세로 영상", fontSize = 20.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(p.getJSONArray("cues").optJSONObject(0)?.optString("text") ?: "우리의 대화", fontSize = 25.sp)
                TextButton(onClick = onExpand, shape = ShortButtonShape) { Text(if (ui.expanded) "자막 접기" else "전체 자막", fontSize = 20.sp) }
                if (ui.expanded) { jsonObjects(p.getJSONArray("cues")).forEach { Text("${it.getDouble("start")}초 · ${it.getString("text")}", fontSize = 20.sp) }; val warnings = p.getJSONArray("warnings"); for (i in 0 until warnings.length()) Text(warnings.getString(i), fontSize = 18.sp) }
            }
            TextButton(onClick = onOptions, shape = ShortButtonShape) { Text(if (ui.options) "추가 설정 닫기" else "추가 설정", fontSize = 20.sp) }
            if (ui.options) Row(verticalAlignment = Alignment.CenterVertically) { Column(Modifier.weight(1f)) { Text("원음도 외부 제작에 사용", fontSize = 22.sp); Text("끄더라도 최종 영상에는 원음이 들어가요", fontSize = 18.sp, color = MaterialTheme.colorScheme.onSurfaceVariant) }; Switch(checked = ui.audio, enabled = !ui.busy && !ui.hasPending, onCheckedChange = onAudio) }
            if (!ui.remote) Text("새 영상을 만들려면 모두의 기록 동의와 서버 연결이 필요해요.", fontSize = 20.sp)
            else if (ui.catalog?.optBoolean("enabled") != true) Text("AI 영상 제작은 준비 중이에요. 지금은 기본 영상으로 남길 수 있어요.", fontSize = 20.sp)
            Button(onClick = onReview, enabled = !ui.busy && ui.remote && ui.catalog?.optBoolean("enabled") == true && (ui.plan != null || ui.hasPending), shape = ShortButtonShape, modifier = Modifier.fillMaxWidth().heightIn(min = 64.dp)) { Text(if (!ui.hasPending) "이 구성으로 만들기" else "이전 요청 접수 확인", fontSize = 24.sp) }
            TextButton(onClick = onLocal, enabled = !ui.busy && ui.remote, shape = ShortButtonShape) { Text("기본 영상으로 만들기", fontSize = 22.sp) }
            TextButton(onClick = onRecommend, enabled = !ui.busy && !ui.hasPending && ui.remote, shape = ShortButtonShape) { Text("다른 장면 추천", fontSize = 20.sp) }
        }
        if (ui.busy) LinearProgressIndicator(modifier = Modifier.fillMaxWidth(), color = MaterialTheme.colorScheme.onSurface)
    }
}

@Composable
private fun ShortTile(item: FeedShort, cached: Bitmap?, modifier: Modifier, enabled: Boolean, onBitmap: (Bitmap) -> Unit, onClick: () -> Unit, onDelete: (LibraryShort) -> Unit) {
    val context = LocalContext.current
    LaunchedEffect(item.key) { if (cached == null && item.stored != null) withContext(Dispatchers.IO) { shortThumbnail(context, item.stored.uri) }?.let(onBitmap) }
    Column(modifier.clickable(enabled = enabled, onClick = onClick), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Box(Modifier.fillMaxWidth().aspectRatio(9f / 16f).clip(RoundedCornerShape(8.dp)).background(MediaBackground)) {
            if (cached != null) Image(cached.asImageBitmap(), contentDescription = item.title, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
            else Text(if (item.stored == null) "완성된 쇼츠" else "표지 불러오는 중", color = MediaSecondary, fontSize = 16.sp, modifier = Modifier.align(Alignment.Center).padding(8.dp))
            Text(shortDuration(item.durationMs), color = MediaInk, fontSize = 16.sp, modifier = Modifier.align(Alignment.BottomEnd).background(MediaBackground.copy(alpha = .8f)).padding(6.dp))
        }
        Text(item.title, fontSize = 20.sp, fontWeight = FontWeight.Medium, maxLines = 2, overflow = TextOverflow.Ellipsis)
        Text((if (item.stored != null) "기기에 저장 · " else "이번 여행 · ") + SimpleDateFormat("M월 d일", Locale.KOREA).format(Date(item.whenMs)), fontSize = 16.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        item.stored?.let { local -> TextButton(onClick = { onDelete(local) }, enabled = enabled, shape = ShortButtonShape, contentPadding = PaddingValues(0.dp)) { Text("삭제", fontSize = 18.sp, color = MaterialTheme.colorScheme.onSurfaceVariant) } }
    }
}

@Composable
private fun MediaAction(label: String, icon: String, enabled: Boolean, onClick: () -> Unit) {
    Column(Modifier.width(84.dp).heightIn(min = 76.dp).clickable(enabled = enabled, onClick = onClick).semantics { contentDescription = label }.padding(8.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        val ink = MediaInk.copy(alpha = if (enabled) 1f else .45f)
        Canvas(Modifier.size(28.dp)) {
            val w = size.width; val h = size.height; val stroke = 2.dp.toPx()
            fun line(x1: Float, y1: Float, x2: Float, y2: Float) = drawLine(ink, Offset(w*x1,h*y1),Offset(w*x2,h*y2),strokeWidth=stroke)
            when(icon) {
                "play" -> drawPath(Path().apply { moveTo(w*.25f,h*.15f); lineTo(w*.8f,h*.5f); lineTo(w*.25f,h*.85f); close() }, ink, style=Stroke(stroke))
                "pause" -> { line(.3f,.15f,.3f,.85f);line(.7f,.15f,.7f,.85f) }
                "save" -> { line(.5f,.1f,.5f,.65f);line(.25f,.45f,.5f,.7f);line(.5f,.7f,.75f,.45f);line(.15f,.72f,.15f,.9f);line(.15f,.9f,.85f,.9f);line(.85f,.9f,.85f,.72f) }
                "sound" -> { drawPath(Path().apply { moveTo(w*.12f,h*.38f); lineTo(w*.3f,h*.38f); lineTo(w*.52f,h*.2f); lineTo(w*.52f,h*.8f); lineTo(w*.3f,h*.62f); lineTo(w*.12f,h*.62f); close() }, ink, style=Stroke(stroke)); line(.72f,.32f,.84f,.5f); line(.84f,.5f,.72f,.68f) }
                "share" -> { line(.45f,.65f,.45f,.12f);line(.22f,.35f,.45f,.1f);line(.45f,.1f,.68f,.35f);line(.15f,.5f,.15f,.9f);line(.15f,.9f,.85f,.9f);line(.85f,.9f,.85f,.5f) }
            }
        }
        Text(label, color = ink, fontSize = 16.sp, maxLines = 1, softWrap = false)
    }
}
