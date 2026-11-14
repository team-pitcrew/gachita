package io.github.teampitcrew.gachita

import org.json.JSONObject

data class TranscriptLine(val device: String, val seq: Int, val at: Long, val text: String, val participantId: String?, val edited: Boolean)

/** A trip place recorded by the car (A3 `places`). Read from the transcript response, which only consenting participants get. */
data class TripPlace(val name: String, val at: Long, val kind: String)

/**
 * asks: (device, seq) of lines the server derived a todo from (`todos[].sources`), shown as '{이름}의 부탁' cards.
 * places: the trip's recorded places sorted by time; empty when the server does not send them (before A3).
 */
data class Transcript(val generation: Int, val lines: List<TranscriptLine>, val asks: Set<Pair<String, Int>> = emptySet(), val places: List<TripPlace> = emptyList())

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
    val todos = root.optJSONArray("todos")
    val asks = (0 until (todos?.length() ?: 0)).flatMap { i ->
        val sources = todos!!.getJSONObject(i).getJSONArray("sources")
        (0 until sources.length()).map { j -> sources.getJSONObject(j).let { it.getString("device") to it.getInt("seq") } }
    }.toSet()
    val placeRows = root.optJSONArray("places")
    val places = (0 until (placeRows?.length() ?: 0)).map { i -> placeRows!!.getJSONObject(i).let { TripPlace(it.optString("name").trim(), it.optLong("at", 0), it.optString("kind")) } }
        .filter { it.name.isNotEmpty() && it.at > 0 }.sortedBy { it.at }
    return Transcript(root.getInt("generation"), lines, asks, places)
}
