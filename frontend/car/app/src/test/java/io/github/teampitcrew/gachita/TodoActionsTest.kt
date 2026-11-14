package io.github.teampitcrew.gachita

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File

/** 차 안 할 일 행동 항목(T144): TodoActions.kt가 서버(todos.js, place-rules-v2)와 같은 발화에 같은 할 일을 내는지. */
class TodoActionsTest {
    // 서버 시험(backend/api/todo-vectors.test.js)과 같은 파일. 규칙을 한쪽만 고치면 여기서 걸린다.
    private val fixture = JSONObject(File("../../../backend/api/todo-vectors.json").readText())
    private fun JSONArray.objects() = (0 until length()).map(::getJSONObject)
    private fun JSONArray.strings() = (0 until length()).map(::getString)

    @Test fun sameTodosAsServer() {
        assertEquals(fixture.getString("method"), TODO_ACTION_METHOD)
        val cases = fixture.getJSONArray("cases").objects()
        assertEquals(18, cases.size)
        for (c in cases) {
            val lines = c.getJSONArray("lines").objects().map {
                TodoLine(it.getString("device"), it.getLong("seq"), it.getLong("at"), it.getString("text"), if (it.has("participantId")) it.getString("participantId") else null)
            }
            val want = c.getJSONArray("todos").objects().map {
                listOf(it.getString("id"), it.getString("place"), it.getString("text"), it.getString("category"), it.getString("title"),
                    it.getJSONArray("items").objects().map { g -> TodoGood(g.getString("name"), if (g.isNull("qty")) null else g.getString("qty")) },
                    it.getJSONArray("requestedBy").strings(), it.getString("method"))
            }
            val got = deriveActionTodos(lines).map { listOf(it.id, it.place, it.text, it.category, it.title, it.items, it.requestedBy, it.method) }
            assertEquals(c.getString("name"), want, got)
        }
    }
}
