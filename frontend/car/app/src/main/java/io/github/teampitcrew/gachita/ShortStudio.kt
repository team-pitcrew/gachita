package io.github.teampitcrew.gachita

import android.content.ClipData
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.os.Environment
import android.provider.MediaStore
import android.widget.MediaController
import android.widget.VideoView
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import kotlinx.coroutines.*
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean

/** 같은 여행·동의 세대에서만 표시합니다. 전송 전에 보관한 키로 접수 결과를 다시 확인합니다. */
@Composable
internal fun ShortStudio(base: String, code: String, generation: Int, token: String, canRead: () -> Boolean, onClose: () -> Unit, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val currentAccess by rememberUpdatedState(canRead)
    val api = remember(base) { Server(base) }
    val scope = rememberCoroutineScope()
    val alive = remember { AtomicBoolean(true) }
    val prefs = remember { context.getSharedPreferences("short-generation", Context.MODE_PRIVATE) }
    // 토큰 값은 저장하지 않고, 토큰별 요청을 구별하는 해시만 키에 씁니다.
    val key = remember { "$code:$generation:" + java.security.MessageDigest.getInstance("SHA-256").digest(token.toByteArray()).joinToString("") { "%02x".format(it) } }
    var pending by remember { mutableStateOf(prefs.getString(key, null)?.let(::JSONObject)) }
    var catalog by remember { mutableStateOf<JSONObject?>(null) }
    var jobs by remember { mutableStateOf<List<JSONObject>>(emptyList()) }
    var plan by remember { mutableStateOf<JSONObject?>(null) }
    var template by remember { mutableStateOf(pending?.optString("templateId") ?: "car-sitcom-v1") }
    var audio by remember { mutableStateOf(pending?.optBoolean("audioReference") ?: false) }
    var consent by remember { mutableStateOf(false) }
    var expanded by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var note by remember { mutableStateOf("") }
    var clip by remember { mutableStateOf<File?>(null) }
    var selected by remember { mutableStateOf<JSONObject?>(null) }
    var saved by remember { mutableStateOf<SavedShortVideo?>(null) }
    var playing by remember { mutableStateOf(false) }
    val video = remember { VideoView(context).apply { setMediaController(MediaController(context)) } }
    val temporary = remember { mutableListOf<File>() }
    fun check() { check(alive.get() && currentAccess()) { "여행과 기록 동의를 다시 확인해 주세요" } }
    fun clearVideo() { video.stopPlayback(); playing = false; clip?.delete(); clip = null; saved = null }
    suspend fun <T> io(block: () -> T): T = withContext(Dispatchers.IO) { check(); block().also { check() } }
    fun perform(block: suspend () -> Unit) {
        if (busy) return
        busy = true; note = ""
        scope.launch {
            try { check(); block() }
            catch (e: CancellationException) { throw e }
            catch (e: Exception) { note = e.message ?: "연결을 다시 확인해 주세요"; if (e is ApiError && e.status in listOf(401, 403, 404, 409, 410)) { plan = null; clearVideo() } }
            finally { busy = false }
        }
    }
    fun array(a: JSONArray) = (0 until a.length()).map(a::getJSONObject)
    suspend fun refreshJobs() { jobs = array(io { api.shortJobs(code, token) }) }
    fun preview() = perform { plan = null; consent = false; plan = io { api.shortPlan(code, token, template, audio).also { require(it.getInt("generation") == generation) } } }
    fun rememberPending(value: JSONObject?) {
        check(prefs.edit().apply { if (value == null) remove(key) else putString(key, value.toString()) }.commit()) { "제작 요청을 보관하지 못했어요" }
        pending = value
    }
    DisposableEffect(Unit) {
        CaptureService.hold(true)
        video.setOnPreparedListener { video.seekTo(1) }
        video.setOnCompletionListener { playing = false }
        video.setOnErrorListener { _, _, _ -> playing = false; note = "영상을 재생하지 못했어요. 다시 열어 주세요."; true }
        onDispose { alive.set(false); video.stopPlayback(); temporary.forEach { it.delete() }; CaptureService.hold(false) }
    }
    LaunchedEffect(Unit) {
        perform { catalog = io { api.shortTemplates() }; refreshJobs(); if (pending == null) plan = io { api.shortPlan(code, token, template, audio) } }
        while (isActive) {
            delay(5000)
            if (!currentAccess()) { onClose(); break }
            if (!busy) try {
                refreshJobs()
                selected?.let { io { api.completedShortJob(code, token, it.getString("id")) } }
            } catch (e: CancellationException) { throw e } catch (e: Exception) { clearVideo(); note = e.message ?: "연결을 확인해 주세요" }
        }
    }
    Column(modifier.verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text("우리 여행의 쇼츠", fontSize = 30.sp)
            OutlinedButton(onClick = onClose) { Text("닫기") }
        }
        Text("원래 목소리와 자막으로 짧은 이야기를 만들어요", fontSize = 20.sp)
        catalog?.getJSONArray("templates")?.let { ts ->
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) { array(ts).forEach { t ->
                FilterChip(selected = template == t.getString("id"), onClick = { template = t.getString("id"); preview() }, enabled = !busy && pending == null, label = { Text(t.getString("name"), fontSize = 22.sp) })
            } }
        }
        plan?.let { p ->
            Surface(color = MaterialTheme.colorScheme.surfaceVariant, shape = MaterialTheme.shapes.large) {
                Column(Modifier.fillMaxWidth().padding(20.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text(p.getString("title"), fontSize = 26.sp)
                    Text("${p.getDouble("seconds").toInt()}초 · 세로 영상 · ${p.getJSONArray("shots").length()}개 장면", fontSize = 20.sp)
                    Text(p.getJSONArray("cues").optJSONObject(0)?.optString("text") ?: "우리의 대화", fontSize = 24.sp)
                    Text("등장인물 · " + array(p.getJSONArray("cast")).joinToString(" / ") { it.getString("name") }, fontSize = 18.sp)
                    OutlinedButton(onClick = { expanded = !expanded }) { Text(if (expanded) "자막 접기" else "전체 자막 확인", fontSize = 20.sp) }
                    if (expanded) {
                        array(p.getJSONArray("cues")).forEach { Text("${it.getDouble("start")}초 · ${it.getString("text")}", fontSize = 20.sp) }
                        val warnings = p.getJSONArray("warnings")
                        for (i in 0 until warnings.length()) Text(warnings.getString(i), fontSize = 18.sp)
                    }
                }
            }
        }
        Row { Checkbox(checked = audio, enabled = !busy && pending == null, onCheckedChange = { audio = it; preview() }); Text("원음을 외부 영상 제작에도 사용해요 (선택)", fontSize = 20.sp) }
        Text("최종 영상에는 이 선택과 관계없이 원래 목소리가 들어가요.", fontSize = 18.sp)
        Row { Checkbox(checked = consent, enabled = !busy && catalog?.optBoolean("enabled") == true, onCheckedChange = { consent = it }); Text("캐릭터와 반응 시각${if (audio) ", 원음" else ""}을 Higgsfield에 보내 영상 제작에 사용하는 데 동의해요.", fontSize = 20.sp) }
        Button(enabled = !busy && consent && catalog?.optBoolean("enabled") == true && (plan != null || pending != null), onClick = { perform {
            if (pending == null) rememberPending(generationRequest(requireNotNull(plan), UUID.randomUUID().toString(), consent))
            try { val job = io { api.createShortJob(code, token, pending!!) }; rememberPending(null); plan = null; jobs = listOf(job) + jobs.filter { it.getString("id") != job.getString("id") } }
            catch (e: ApiError) { if (e.status in 400..499) { rememberPending(null); plan = null }; throw e }
        } }, modifier = Modifier.fillMaxWidth().heightIn(min = 64.dp)) { Text(if (pending == null) "AI 쇼츠 만들기" else "이전 요청 접수 확인", fontSize = 24.sp) }
        if (catalog?.optBoolean("enabled") != true) Text("AI 영상 제작을 준비하고 있어요. 지금은 구성을 미리 확인할 수 있어요.", fontSize = 20.sp)
        if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        if (note.isNotBlank()) Text(note, fontSize = 20.sp)
        OutlinedButton(onClick = ::preview, enabled = !busy && pending == null) { Text("장면 다시 추천", fontSize = 20.sp) }
        clip?.let { file ->
            AndroidView(factory = { video }, update = { if (video.tag != file.path) { video.tag = file.path; video.setVideoPath(file.path) } }, modifier = Modifier.fillMaxWidth().height(440.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedButton(onClick = { if (video.isPlaying) { video.pause(); playing = false } else { video.start(); playing = true } }) { Text(if (playing) "일시정지" else "재생", fontSize = 22.sp) }
                Button(enabled = !busy, onClick = { perform {
                    val job = requireNotNull(selected)
                    saved = io {
                        api.completedShortJob(code, token, job.getString("id"))
                        val resolver = context.contentResolver
                        val name = "가치타_${UUID.randomUUID()}.mp4"
                        val uri = requireNotNull(resolver.insert(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, ContentValues().apply {
                            put(MediaStore.Video.Media.DISPLAY_NAME, name); put(MediaStore.Video.Media.MIME_TYPE, "video/mp4"); put(MediaStore.Video.Media.RELATIVE_PATH, "${Environment.DIRECTORY_MOVIES}/Gachita"); put(MediaStore.Video.Media.IS_PENDING, 1)
                        }))
                        try {
                            requireNotNull(resolver.openOutputStream(uri)).use { out -> file.inputStream().use { it.copyTo(out) } }
                            api.completedShortJob(code, token, job.getString("id")); check()
                            check(resolver.update(uri, ContentValues().apply { put(MediaStore.Video.Media.IS_PENDING, 0) }, null, null) == 1)
                            SavedShortVideo(uri, name, (job.getJSONObject("result").getDouble("seconds") * 1000).toLong())
                        } catch (e: Exception) { resolver.delete(uri, null, null); throw e }
                    }
                    note = "갤러리에 저장했어요"
                } }) { Text("영상 저장", fontSize = 22.sp) }
                saved?.let { result -> Button(enabled = !busy, onClick = { perform {
                    io { api.completedShortJob(code, token, requireNotNull(selected).getString("id")) }; check()
                    context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).apply { type = "video/mp4"; putExtra(Intent.EXTRA_STREAM, result.uri); clipData = ClipData.newRawUri("가치타 쇼츠", result.uri); addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION) }, "쇼츠 공유"))
                } }) { Text("공유", fontSize = 22.sp) } }
            }
            Text("저장한 영상은 동의를 꺼도 기기에 남아요.", fontSize = 18.sp)
        }
        Text("만든 쇼츠", fontSize = 26.sp)
        if (jobs.isEmpty()) Text("완성한 쇼츠가 여기에 모여요.", fontSize = 20.sp)
        jobs.forEach { job ->
            Text(generationLabel(job) + if (generationActive(job)) " · ${job.getJSONObject("progress").getInt("completedShots")}/${job.getJSONObject("progress").getInt("totalShots")} 장면" else "", fontSize = 22.sp)
            if (job.optString("state") == "completed") Button(enabled = !busy, onClick = { perform {
                clearVideo(); selected = null
                val file = File.createTempFile("short-generated-", ".mp4", context.cacheDir).also { temporary.add(it) }
                try { io { api.downloadShort(generationFile(base, code, job), token, file, { !alive.get() }, {}, maxBytes = 100_000_000, mimeType = "video/mp4"); api.completedShortJob(code, token, job.getString("id")) }; clip = file; selected = job }
                catch (e: Exception) { file.delete(); throw e }
            } }) { Text("영상 열기", fontSize = 22.sp) }
            if (generationActive(job)) OutlinedButton(enabled = !busy, onClick = { perform { io { api.cancelShortJob(code, token, job.getString("id")) }; refreshJobs() } }) { Text("제작 취소", fontSize = 22.sp) }
        }
        OutlinedButton(enabled = !busy, onClick = { perform { refreshJobs() } }) { Text("제작 상태 새로고침", fontSize = 20.sp) }
    }
}
