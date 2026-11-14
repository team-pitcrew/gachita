package io.github.teampitcrew.gachita

import org.json.JSONObject
import java.net.URI

internal fun generationRequest(plan: JSONObject, key: String, consent: Boolean): JSONObject {
    require(consent) { "외부 영상 제작에 동의해 주세요" }
    require(key.matches(Regex("[A-Za-z0-9_-]{8,100}")))
    return JSONObject().apply {
        listOf("momentId", "templateId", "generation", "planHash", "audioReference").forEach { put(it, plan.get(it)) }
        put("externalGenerationConsent", true); put("idempotencyKey", key)
    }
}

internal fun generationFile(base: String, code: String, job: JSONObject): String {
    val id = job.getString("id")
    require(id.matches(Regex("[a-zA-Z0-9_-]+")))
    val path = "/api/trips/$code/short-generations/$id/file"
    require(job.getString("state") == "completed" && job.getJSONObject("result").getString("url") == path) { "완성된 영상 주소를 확인하지 못했어요" }
    val origin = URI(base.trimEnd('/'))
    require(origin.scheme in listOf("http", "https") && origin.rawQuery == null && origin.rawUserInfo == null && origin.rawFragment == null)
    return base.trimEnd('/') + path
}

internal fun generationActive(job: JSONObject) = job.optString("state") in listOf("queued", "submitting", "generating", "composing")
internal fun generationLabel(job: JSONObject): String = when (job.optString("state")) {
    "queued" -> "제작 대기"
    "submitting" -> "장면 보내는 중"
    "generating" -> "장면 만드는 중"
    "composing" -> "원음과 자막을 담는 중"
    "completed" -> "영상 완성"
    "failed" -> "제작 실패"
    "canceled" -> "제작 취소"
    "submission_unknown" -> "접수 확인 필요 · 다시 생성하지 말고 문의해 주세요"
    else -> "상태 확인 중"
}
