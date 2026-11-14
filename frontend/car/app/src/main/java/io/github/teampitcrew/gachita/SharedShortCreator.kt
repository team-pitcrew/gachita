package io.github.teampitcrew.gachita

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import kotlinx.coroutines.*
import org.json.JSONObject
import java.io.File
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

private class SharedSourceChanged : IllegalStateException("원음·자막·화자가 바뀌었어요. 새로 만들어 주세요")
private data class PendingSharedShort(val source: SharedShortSource, val file: File, val key: String, val sha256: String)

/** Server source owns the cast/captions. A local retry owns exactly one file and idempotency key. */
@Composable
internal fun SharedShortCreator(base: String, code: String, generation: Int, token: String, canUse: () -> Boolean,
    onClose: () -> Unit, onSaved: (JSONObject) -> Unit) {
    val context = LocalContext.current
    val access by rememberUpdatedState(canUse)
    val scope = rememberCoroutineScope()
    val alive = remember { AtomicBoolean(true) }
    val api = remember { SharedShortApi(base) }
    val control = remember { ShortExportControl() }
    val connection = remember { AtomicReference<java.net.HttpURLConnection?>(null) }
    val directory = remember { File(context.cacheDir, "shared-short-${UUID.randomUUID()}") }
    var scenes by remember { mutableStateOf<List<Scene>>(emptyList()) }
    var chosen by remember { mutableStateOf<String?>(null) }
    var pending by remember { mutableStateOf<PendingSharedShort?>(null) }
    var busy by remember { mutableStateOf(false) }
    var loading by remember { mutableStateOf(true) }
    var note by remember { mutableStateOf("") }
    var progress by remember { mutableStateOf(0f) }
    fun checkAccess() { control.check(); check(alive.get() && access()) { "주차 상태와 모두의 기록 동의를 확인해 주세요" } }
    fun verify(source: SharedShortSource) {
        checkAccess()
        if (!sharedShortSame(source, api.source(code, token, source.moment))) throw SharedSourceChanged()
        checkAccess()
    }
    DisposableEffect(Unit) {
        onDispose { alive.set(false); control.cancel(); api.cancel(); connection.getAndSet(null)?.disconnect(); directory.deleteRecursively() }
    }
    LaunchedEffect(Unit) {
        try {
            scenes = withContext(Dispatchers.IO) { checkAccess(); parseShort(Server(base).shortform(code, token)).also { require(it.generation == generation) }.scenes.filter { it.momentId.isNotBlank() && it.seconds in .5..60.0 } }
            chosen = scenes.firstOrNull()?.momentId
        } catch (e: CancellationException) { throw e } catch (e: Exception) { note = e.message ?: "장면을 불러오지 못했어요" } finally { loading = false }
    }
    LaunchedEffect(access()) { if (!access()) onClose() }
    fun create() {
        if (busy || chosen == null) return
        busy = true; note = "원음과 자막을 확인하고 있어요"; progress = 0f
        scope.launch {
            try {
                val saved = withContext(Dispatchers.IO) {
                    checkAccess()
                    val ready = pending ?: run {
                        val source = api.source(code, token, requireNotNull(chosen))
                        require(source.generation == generation)
                        require(directory.mkdirs() || directory.isDirectory)
                        val clip = File(directory, "source.wav")
                        Server(base).downloadShort(shortClipAddress(base, code, source.short.scenes.single().clip), token, clip,
                            { control.isCancelled || !alive.get() }, { c -> connection.set(c); if (control.isCancelled) c?.disconnect() })
                        verify(source)
                        val file = File(directory, "render.mp4")
                        withContext(Dispatchers.Main) { note = "1080p 영상에 원래 목소리를 담고 있어요" }
                        exportShortVideo(context, source.short, listOf(clip), emptyList(), control, beforePublish = { verify(source) },
                            onProgress = { value -> scope.launch { if (alive.get()) progress = value * .8f } }, targetFile = file, maxSeconds = 60)
                        verify(source)
                        PendingSharedShort(source, file, UUID.randomUUID().toString(), shortFileHash(file)).also { value ->
                            withContext(Dispatchers.Main) { pending = value }
                        }
                    }
                    verify(ready.source)
                    withContext(Dispatchers.Main) { note = "같이 탄 사람들의 보관함에 올리고 있어요" }
                    api.upload(code, token, ready.source, ready.file, ready.key, ready.sha256) { value -> scope.launch { if (alive.get()) progress = .8f + value * .2f } }
                        .also { verify(ready.source) }
                }
                checkAccess(); onSaved(saved)
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) {
                note = e.message ?: "공용 보관을 마치지 못했어요. 같은 파일로 다시 시도해 주세요"
                if (e is SharedSourceChanged || (e is ApiError && e.status in listOf(400, 401, 403, 404, 410, 413))) { pending = null; directory.deleteRecursively() }
            } finally {
                busy = false
                if (!alive.get() || control.isCancelled) directory.deleteRecursively()
            }
        }
    }
    Dialog(onDismissRequest = { if (!busy) onClose() }, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(shape = RoundedCornerShape(12.dp), modifier = Modifier.fillMaxWidth(.9f).fillMaxHeight(.9f)) {
            Column(Modifier.padding(24.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                Text("함께 남길 장면", fontSize = 28.sp)
                Text("1080p · 원래 목소리 · 같이 탄 사람들의 보관함", fontSize = 20.sp)
                if (loading) LinearProgressIndicator(Modifier.fillMaxWidth())
                scenes.forEach { scene ->
                    OutlinedButton(onClick = { chosen = scene.momentId }, enabled = !busy && pending == null,
                        shape = RoundedCornerShape(10.dp), modifier = Modifier.fillMaxWidth(),
                        colors = ButtonDefaults.outlinedButtonColors(containerColor = if (chosen == scene.momentId) MaterialTheme.colorScheme.secondaryContainer else MaterialTheme.colorScheme.surface)) {
                        Column(Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
                            Text(scene.label.ifBlank { "함께 남긴 장면" } + " · ${scene.seconds.toInt()}초", fontSize = 22.sp)
                            Text(scene.cues.firstOrNull()?.text.orEmpty(), fontSize = 18.sp, maxLines = 2)
                        }
                    }
                }
                if (!loading && scenes.isEmpty()) Text("원음이 준비된 장면이 없어요. 대화에서 남길 장면을 먼저 골라 주세요.", fontSize = 22.sp)
                if (note.isNotBlank()) Text(note, fontSize = 20.sp)
                if (busy) LinearProgressIndicator(progress = { progress }, modifier = Modifier.fillMaxWidth())
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    OutlinedButton(onClick = onClose, shape = RoundedCornerShape(10.dp)) { Text(if (busy) "취소" else "닫기", fontSize = 22.sp) }
                    Button(onClick = ::create, enabled = !busy && chosen != null && access(), shape = RoundedCornerShape(10.dp)) {
                        Text(if (pending == null) "만들고 함께 보관" else "같은 영상 다시 보관", fontSize = 22.sp)
                    }
                }
                Text("기기에 있던 영상은 사본으로 남아요. 원본 정보가 없는 사본은 자동으로 공용 보관함에 올리지 않아요.", fontSize = 17.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}
