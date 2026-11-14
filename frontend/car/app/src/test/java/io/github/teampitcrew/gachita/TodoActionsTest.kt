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

    @Test fun carTodosTakeServerStateAndKeepServerOnly() {
        val own = deriveActionTodos(listOf(
            TodoLine("car", 1, 1_000, "마트에서 우유 사자"),
            TodoLine("car", 2, 2_000, "편의점에서 물 사자"), // 서버가 교정본으로 다른 할 일을 냄
            TodoLine("car", 3, 3_000, "숙소에서 짐 내리자"), // 서버가 아직 받지 못함
        ))
        val src = { seq: Long, at: Long, text: String -> SharedTodoSource("car-1", seq, at, text, text, "mom") }
        val server = listOf(
            SharedTodo(own[0].id, "마트", "마트에서 우유 사자", "done", 2, listOf(src(1, 1_000, "마트에서 우유 사자"))),
            SharedTodo("edited", "편의점", "편의점에서 생수 사자", "pending", 0, listOf(src(2, 2_000, "편의점에서 물 사자"))),
            SharedTodo("phone", "약국", "약국에서 밴드 사자", "pending", 1, listOf(src(9, 9_000, "약국에서 밴드 사자"))),
        )
        val got = withCarTodos(own, server)
        assertEquals(listOf(own[0].id, own[2].id, "edited", "phone"), got.map { it.id })
        assertEquals("done" to 2, got[0].status to got[0].version)
        assertEquals("pending" to 0, got[1].status to got[1].version)
    }
}
