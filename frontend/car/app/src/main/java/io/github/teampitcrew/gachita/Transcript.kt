package io.github.teampitcrew.gachita

import org.json.JSONObject

data class TranscriptLine(val device: String, val seq: Int, val at: Long, val text: String, val participantId: String?, val edited: Boolean)
data class Transcript(val generation: Int, val lines: List<TranscriptLine>)

/** Only the participant-authorized transcript is a group conversation. Never infer a speaker from a seat. */
fun parseTranscript(json: String): Transcript {
    val root = JSONObject(json)
    val rows = root.getJSONArray("utterances")
    val lines = (0 until rows.length()).map { i ->
        val row = rows.getJSONObject(i)
        val text = listOf("displayText", "editedText", "asrText", "text").firstOrNull { row.has(it) && !row.isNull(it) }?.let(row::getString).orEmpty()
        TranscriptLine(row.getString("device"), row.getInt("seq"), row.getLong("at"), text,
            if (row.isNull("participantId")) null else row.optString("participantId").takeIf(String::isNotEmpty),
            row.has("editedText") && !row.isNull("editedText"))
    }.filter { it.text.isNotBlank() }.sortedBy { it.at }
    return Transcript(root.getInt("generation"), lines)
}
