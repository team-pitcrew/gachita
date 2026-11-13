package io.github.teampitcrew.gachita

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.io.File
import java.security.KeyStore
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

// 차 안에 두는 민감정보(받아 적은 글, 할 일, 저장한 여행, 참가자 토큰)의 암호화와 보관 기간(T69, 단위 테스트 VaultTest.kt).
// Pleos 앱 보안 가이드: 기기에 저장하는 민감정보는 저장 위치와 관계없이 암호화하고 키는 Android Keystore에 둔다.

const val KEEP_MS = 48L * 60 * 60 * 1000 // 여행을 만든 뒤 48시간. 보관 시계는 이것 하나뿐(ADR-0007)

/**
 * AES-256-GCM. 봉투는 IV 12바이트 + 암호문 + 태그 16바이트. 키는 앱 밖으로 꺼낼 수 없는 Android Keystore 키(단위 테스트는 소프트웨어 키).
 * 앱 데이터를 지우거나 다시 깔면 키가 바뀌어 옛 파일은 열리지 않는다. 열리지 않는 줄·파일은 없는 것으로 다룬다.
 */
class Seal(private val key: SecretKey) {
    fun close(plain: ByteArray): ByteArray = Cipher.getInstance(GCM).run { init(Cipher.ENCRYPT_MODE, key); iv + doFinal(plain) }

    fun open(box: ByteArray): ByteArray = Cipher.getInstance(GCM).run {
        init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, box, 0, 12)); doFinal(box, 12, box.size - 12)
    }

    /** 글 한 줄 ↔ Base64 한 줄. 쓰다 끊긴 줄은 태그가 맞지 않아 unline이 던진다. */
    fun line(text: String): String = Base64.getEncoder().encodeToString(close(text.toByteArray()))
    fun unline(line: String): String = String(open(Base64.getDecoder().decode(line.trim())))

    companion object {
        private const val GCM = "AES/GCM/NoPadding"
        private const val ALIAS = "gachita-vault"

        /** 이 앱의 Keystore 키(처음이면 만든다). 메인 스레드에서 불러도 된다(키 하나를 읽거나 만듦). */
        fun keystore(): Seal {
            val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            val key = ks.getKey(ALIAS, null) as SecretKey? ?: KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
                init(
                    KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                        .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build()
                )
                generateKey()
            }
            return Seal(key)
        }
    }
}

/** 여행 하나에 딸린 차 안 파일: 보관함(utterances-<코드>.jsonl·.acked·.tmp)과 할 일(todos-<코드>.json·.tmp). */
private val TRIP_FILE = Regex("^(?:utterances|todos)-([A-Z0-9]+)\\.")

fun tripFiles(dir: File, code: String): List<File> = dir.listFiles().orEmpty().filter { TRIP_FILE.find(it.name)?.groupValues?.get(1) == code }

/** 여행 하나의 차 안 파일을 모두 지운다(서버가 여행을 모름, 48시간). */
fun dropTrip(dir: File, code: String) = tripFiles(dir, code).forEach { it.delete() }

/**
 * 여행을 만든 뒤 48시간이 지난 여행의 파일을 지운다. 만든 시각은 보관함이 적어 둔 여행의 createdAt이고(통신이 끊겨도 지울 수 있게),
 * 적힌 것이 없거나 열리지 않으면(키가 바뀜) 그 여행 파일 가운데 가장 늦게 고친 시각으로 잰다. 지운 여행 코드를 돌려준다.
 */
fun sweep(dir: File, seal: Seal, now: Long, keepMs: Long = KEEP_MS): List<String> =
    dir.listFiles().orEmpty().mapNotNull { TRIP_FILE.find(it.name)?.groupValues?.get(1) }.distinct().filter { code ->
        val born = Outbox.createdAtOf(dir, code, seal) ?: tripFiles(dir, code).maxOf { it.lastModified() }
        (now - born > keepMs).also { if (it) dropTrip(dir, code) }
    }
