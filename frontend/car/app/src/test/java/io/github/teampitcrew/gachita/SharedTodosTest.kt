package io.github.teampitcrew.gachita

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL

class SharedTodosTest {
    private val scope = TodoScope("https://example.org", "ABC234", 3, "participant-test-token")
    private fun item(status: String = "pending", version: Int = 2) = JSONObject().put("id", "a".repeat(32)).put("place", "마트")
        .put("text", "마트에서 물 사자").put("status", status).put("version", version)
        .put("sources", JSONArray().put(JSONObject().put("device", "car").put("seq", 7).put("at", 1000)
            .put("text", "마트에서 물 사자아").put("displayText", "마트에서 물 사자").put("participantId", "p1")))
    private fun list(generation: Int = 3) = JSONObject().put("generation", generation).put("method", "place-rules-v1").put("items", JSONArray().put(item()))
    private val place = Place(37.75, 128.9, "이마트 강릉점")
    private val observation = VehicleArrival(place, 37.7501, 128.9001, 10000)
    private fun arrival(eligible: Boolean = true) = JSONObject().put("generation", 3).put("source", "vehicle").put("eligible", eligible)
        .put("observedAt", 10000).put("reason", if (eligible) JSONObject.NULL else "outside_place")
        .put("place", JSONObject().put("name", place.name).put("lat", place.lat).put("lng", place.lng)).put("items", JSONArray().put(item()))

    @Test fun serverSourcesAndVersionAreKeptInsteadOfLocalExtraction() {
        val parsed = sharedTodos(list().toString())
        assertEquals(3, parsed.generation); assertEquals("place-rules-v1", parsed.method)
        val row = parsed.items.single(); assertEquals(2, row.version)
        assertEquals("마트에서 물 사자", row.text)
        assertEquals("마트에서 물 사자아", row.sources.single().text)
        assertEquals("마트에서 물 사자", row.sources.single().displayText)
        assertEquals("p1", row.sources.single().participantId)
        assertThrows(IllegalArgumentException::class.java) { sharedTodo(item("invented")) }
        assertThrows(Exception::class.java) { sharedTodos("{}") }
    }

    @Test fun staleTripConsentTokenAndOlderRequestsCannotRestoreList() {
        val (loading, attempt) = SharedTodoState().bind(scope).begin()
        val good = sharedTodos(list().toString())
        val saved = loading.received(attempt, good, 20000)
        assertEquals(good, saved.data); assertEquals(20000L, saved.syncedAt)
        for (changed in listOf(scope.copy(trip = "OTHER1"), scope.copy(generation = 4), scope.copy(token = "new-token"), scope.copy(server = "https://other.example"))) {
            val next = saved.bind(changed)
            assertNull(next.data); assertNull(next.syncedAt)
            assertEquals(next, next.received(attempt, good, 30000))
        }
        val (newer, _) = saved.begin()
        assertEquals(newer, newer.received(attempt, good, 30000))
        assertNull(loading.received(attempt, good.copy(generation = 4), 30000).data)
    }

    @Test fun failuresKeepLastVerifiedRowsButNeverApplyAnOptimisticStatus() {
        val (first, firstAttempt) = SharedTodoState().bind(scope).begin()
        val saved = first.received(firstAttempt, sharedTodos(list().toString()), 20000)
        val (changing, attempt) = saved.begin()
        assertTrue(changing.items.single().pending)
        val failed = changing.failed(attempt, "409 다른 기기에서 바뀌었어요")
        assertTrue(failed.items.single().pending); assertEquals(20000L, failed.syncedAt); assertFalse(failed.loading)
        assertNull(changing.failed(attempt, "403 동의 철회", clear = true).data)
        val corrected = sharedTodos(list().put("items", JSONArray().put(item("done", 3))).toString())
        val completed = changing.received(attempt, corrected, 30000)
        assertEquals("done", completed.items.single().status); assertEquals(3, completed.items.single().version)
    }

    @Test fun vehicleEvidenceIsNotReplacedWithDestinationOrZeroCoordinates() {
        assertNull(arrivalPlace("마트", 0.0, 0.0)); assertNull(arrivalPlace("", 37.0, 127.0))
        assertFalse(vehiclePoint(Double.NaN, 127.0)); assertFalse(vehiclePoint(91.0, 127.0))
        val body = observation.body(3, true)
        assertEquals("vehicle", body.getString("source")); assertEquals(10000L, body.getLong("observedAt"))
        assertEquals(place.lat, body.getJSONObject("place").getDouble("lat"), 0.0)
        assertEquals(observation.lat, body.getJSONObject("position").getDouble("lat"), 0.0)
        assertNotEquals(body.getJSONObject("place").getDouble("lat"), body.getJSONObject("position").getDouble("lat"))
        assertThrows(IllegalArgumentException::class.java) { observation.copy(lat = 0.0, lng = 0.0).body(3, true) }
    }

    @Test fun onlyMatchingFreshServerEligibleResultCanBeSpoken() {
        val result = sharedArrival(arrival().toString())
        assertTrue(canReadArrival(result, observation, scope, scope, true, 11000))
        assertFalse(canReadArrival(result.copy(eligible = false), observation, scope, scope, true, 11000))
        assertFalse(canReadArrival(result, observation, scope, scope, false, 11000))
        assertFalse(canReadArrival(result, observation, scope, scope.copy(generation = 4), true, 11000))
        assertFalse(canReadArrival(result, observation, scope, scope, true, 71000))
        assertFalse(canReadArrival(result, observation, scope, scope, true, 9000))
        assertFalse(canReadArrival(result.copy(place = place.copy(name = "다른 곳")), observation, scope, scope, true, 11000))
        assertFalse(canReadArrival(result.copy(observedAt = 9000), observation, scope, scope, true, 11000))
        assertFalse(canReadArrival(result.copy(items = listOf(sharedTodo(item("done")))), observation, scope, scope, true, 11000))
    }

    @Test fun initialParkAndLateUxReleaseDoNotPretendArrival() {
        var gate = ArrivalParkingGate()
        fun signal(gear: String?, restricted: Boolean): Boolean {
            val (next, arrived) = gate.observe(gear, restricted); gate = next; return arrived
        }
        assertFalse(signal("P", true))
        assertFalse(signal("P", false))
        assertFalse(signal("P", false))
        assertFalse(signal("D", true))
        assertFalse(signal("P", true))
        assertTrue(signal("P", false))
        assertFalse(signal("P", false))
        assertFalse(signal("D", false))
        assertTrue(signal("P", false))
        assertFalse(signal("D", true))
        assertFalse(signal(null, true))
        assertFalse(signal("P", false))
    }

    private class Connection(url: URL, val response: String, val status: Int = 200) : HttpURLConnection(url) {
        val sent = ByteArrayOutputStream()
        override fun connect() {}
        override fun disconnect() {}
        override fun usingProxy() = false
        override fun setRequestMethod(value: String) { method = value }
        override fun getResponseCode() = status
        override fun getOutputStream() = sent
        override fun getInputStream() = ByteArrayInputStream(response.toByteArray())
        override fun getErrorStream() = ByteArrayInputStream(response.toByteArray())
    }

    @Test fun requestContractUsesBearerGenerationAndVersionAndPreservesServerRejection() {
        val connections = mutableListOf<Connection>()
        var response = list().toString(); var status = 200
        val api = Server(scope.server) { Connection(it, response, status).also(connections::add) }
        assertEquals(3, api.todos(scope.trip, scope.token).generation)
        assertEquals("/api/trips/ABC234/todos", connections.last().url.path)
        assertEquals("Bearer ${scope.token}", connections.last().getRequestProperty("Authorization"))
        response = JSONObject().put("generation", 3).put("item", item("done", 3)).toString()
        api.todoStatus(scope.trip, scope.token, "a".repeat(32), 3, 2, "done")
        val patch = connections.last(); assertEquals("PATCH", patch.requestMethod)
        val body = JSONObject(patch.sent.toString("UTF-8"))
        assertEquals(setOf("generation", "expectedVersion", "status"), body.keySet())
        assertEquals(3, body.getInt("generation")); assertEquals(2, body.getInt("expectedVersion")); assertEquals("done", body.getString("status"))
        response = arrival().toString(); api.arrivalBriefing(scope.trip, scope.token, 3, observation)
        assertEquals("POST", connections.last().requestMethod)
        val arrivalBody = JSONObject(connections.last().sent.toString("UTF-8"))
        assertEquals("vehicle", arrivalBody.getString("source")); assertEquals(10000L, arrivalBody.getLong("observedAt"))
        status = 409; response = """{"error":"다른 참가자가 상태를 바꿨어요"}"""
        val rejected = assertThrows(ApiError::class.java) { api.todoStatus(scope.trip, scope.token, "a".repeat(32), 3, 2, "cancelled") }
        assertEquals(409, rejected.status)
    }
}
