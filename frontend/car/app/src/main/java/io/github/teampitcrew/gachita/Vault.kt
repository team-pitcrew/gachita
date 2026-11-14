package io.github.teampitcrew.gachita

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.io.File
import java.security.KeyStore
import java.util.Base64
import android.util.Log
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

// 차 안에 두는 민감정보(받아 적은 글, 할 일, 저장한 여행, 참가자 토큰, 원음)의 암호화와 보관 기간(T69·T63, 단위 테스트 VaultTest.kt).
// Pleos 앱 보안 가이드: 기기에 저장하는 민감정보는 저장 위치와 관계없이 암호화하고 키는 Android Keystore에 둔다.

/** 기본 보관 기간은 무기한(null)입니다. 유한한 기간은 디버그 만료 시험에서만 전달합니다. */
internal fun retentionExpired(createdAt: Long, now: Long, keepMs: Long? = null): Boolean {
    if (keepMs == null) return false
    require(keepMs >= 0)
    // 무기한을 Long.MAX_VALUE로 더하지 않고, 시험 기간도 시각 덧셈이 넘치지 않을 때만 비교합니다.
    return createdAt <= Long.MAX_VALUE - keepMs && now >= createdAt + keepMs
}

/**
 * AES-256-GCM. 봉투는 IV 12바이트 + 암호문 + 태그 16바이트.
 * 앱이 쓰는 키(keystore())는 데이터 키 하나를 앱 밖으로 꺼낼 수 없는 Android Keystore 키로 감싸 파일(vault.key)에 둔 것이다:
 * 줄·묶음마다 Keystore(binder 호출)를 부르지 않고 앱을 켤 때 한 번만 푼다. 단위 테스트는 소프트웨어 키.
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

        /**
         * 이 앱의 키: dir/vault.key의 데이터 키를 Keystore 키로 풀어 쓴다(처음이면 둘 다 만든다).
         * Keystore 키나 파일이 깨졌으면(OEM 업데이트 뒤 등) 둘 다 새로 만든다. 옛 파일은 열리지 않는 것으로 다룬다. 앱이 죽지 않게.
         */
        fun keystore(dir: File): Seal = runCatching { wrapped(dir, Seal(master())) }.getOrElse {
            Log.w("GachitaVault", "키를 다시 만듦", it)
            runCatching { KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry(ALIAS) }
            File(dir, KEY_FILE).delete()
            wrapped(dir, Seal(master()))
        }

        private const val KEY_FILE = "vault.key"

        /** dir/vault.key의 데이터 키(master로 감쌈). 없으면 새로 만들어 둔다. 열리지 않으면 던진다. */
        fun wrapped(dir: File, master: Seal): Seal {
            val f = File(dir, KEY_FILE)
            val raw = if (f.exists()) master.open(f.readBytes()) else KeyGenerator.getInstance("AES").apply { init(256) }.generateKey().encoded.also {
                val tmp = File(dir, "$KEY_FILE.tmp"); tmp.writeBytes(master.close(it)); check(tmp.renameTo(f)) { "키 파일을 쓰지 못함" }
            }
            return Seal(javax.crypto.spec.SecretKeySpec(raw, "AES"))
        }

        private fun master(): SecretKey {
            val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            return ks.getKey(ALIAS, null) as SecretKey? ?: KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
                init(
                    KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                        .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build()
                )
                generateKey()
            }
        }
    }
}

/** 여행 하나에 딸린 차 안 파일: 보관함(utterances-<코드>.jsonl·.acked·.tmp), 할 일(todos-<코드>.json·.tmp), 원음(audio-<코드>-…raw, T63), 올린 장면(clips-<코드>.done), 말한 사람(speakers-<코드>.jsonl, T37), 목소리 대조 값(voiceprints-<코드>.json, ADR-0023). */
private val TRIP_FILE = Regex("^(?:utterances|todos|audio|clips|speakers|voiceprints|places)-([A-Z0-9]+)[.-]")

fun tripFiles(dir: File, code: String): List<File> = dir.listFiles().orEmpty().filter { TRIP_FILE.find(it.name)?.groupValues?.get(1) == code }

/** 명시적으로 삭제된 여행 하나의 차 안 파일을 모두 지운다. 디버그 만료 시험도 같은 정리를 쓴다. */
fun dropTrip(dir: File, code: String) = tripFiles(dir, code).forEach { it.delete() }

/**
 * 기본값은 기간 제한이 없어 어떤 여행 파일도 시간 때문에 지우지 않는다.
 * 디버그 시험에서 기간을 명시했을 때만 createdAt 기준으로 지우고 지운 여행 코드를 돌려준다.
 * 시험 중 만든 시각을 읽지 못하는 파일도 정리한다. 기기 시계로 잰다.
 */
fun sweep(dir: File, seal: Seal, now: Long, keepMs: Long? = null): List<String> {
    if (keepMs == null) return emptyList()
    require(keepMs >= 0)
    return dir.listFiles().orEmpty().mapNotNull { TRIP_FILE.find(it.name)?.groupValues?.get(1) }.distinct().filter { code ->
        val born = Outbox.createdAtOf(dir, code, seal)
        (born == null || retentionExpired(born, now, keepMs)).also { if (it) dropTrip(dir, code) }
    }
}
