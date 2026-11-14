package io.github.teampitcrew.gachita

import org.json.JSONObject
import java.net.URI

internal fun generationFile(base: String, code: String, job: JSONObject): String {
    val id = job.getString("id")
    require(id.matches(Regex("[a-zA-Z0-9_-]+")))
    val path = "/api/trips/$code/short-generations/$id/file"
    require(job.getString("state") == "completed" && job.getJSONObject("result").getString("url") == path) { "완성된 영상 주소를 확인하지 못했어요" }
    val origin = URI(base.trimEnd('/'))
    require(origin.scheme in listOf("http", "https") && origin.rawQuery == null && origin.rawUserInfo == null && origin.rawFragment == null)
    return base.trimEnd('/') + path
}
