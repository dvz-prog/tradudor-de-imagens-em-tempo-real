package com.tradutor.imagens

import android.annotation.SuppressLint
import android.content.Context
import android.content.SharedPreferences
import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.util.Base64
import android.view.KeyEvent
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.Spinner
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.concurrent.Executors

class MainActivity : AppCompatActivity() {

    private lateinit var web: WebView
    private lateinit var urlBox: EditText
    private lateinit var progress: ProgressBar
    private lateinit var prefs: SharedPreferences
    private lateinit var injected: String
    private var userAgent: String = ""
    private val pool = Executors.newFixedThreadPool(4)
    private val cacheDirPit by lazy { File(cacheDir, "pit").apply { mkdirs() } }

    private val targets = listOf(
        "pt" to "Português", "en" to "Inglês", "es" to "Espanhol", "fr" to "Francês",
        "de" to "Alemão", "it" to "Italiano", "ru" to "Russo", "ja" to "Japonês",
        "ko" to "Coreano", "zh-CN" to "Chinês"
    )
    private val sources = listOf(
        "auto" to "Detectar automaticamente", "jpn" to "Japonês", "kor" to "Coreano",
        "chs" to "Chinês simplificado", "cht" to "Chinês tradicional", "eng" to "Inglês",
        "spa" to "Espanhol", "fre" to "Francês", "ger" to "Alemão", "ita" to "Italiano",
        "por" to "Português", "rus" to "Russo"
    )

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        prefs = getSharedPreferences("pit", Context.MODE_PRIVATE)

        val css = assets.open("pit.css").bufferedReader().use { it.readText() }
        val js = assets.open("pit.js").bufferedReader().use { it.readText() }
        injected = "(function(){if(!document.getElementById('pit-style')){var s=document.createElement('style');" +
            "s.id='pit-style';s.textContent=" + JSONObject.quote(css) + ";document.documentElement.appendChild(s);}})();" + js

        web = findViewById(R.id.web)
        urlBox = findViewById(R.id.url)
        progress = findViewById(R.id.progress)

        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            loadWithOverviewMode = true
            useWideViewPort = true
            mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            setSupportZoom(true)
            builtInZoomControls = true
            displayZoomControls = false
        }
        userAgent = web.settings.userAgentString
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true)
        web.addJavascriptInterface(Bridge(), "PitNative")

        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: android.webkit.WebResourceRequest): Boolean {
                val s = request.url.scheme ?: return true
                return !(s == "http" || s == "https")
            }

            override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
                if (!urlBox.hasFocus()) urlBox.setText(url)
            }

            override fun onPageFinished(view: WebView, url: String) {
                if (url.startsWith("http")) view.evaluateJavascript(injected, null)
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView, newProgress: Int) {
                progress.progress = newProgress
                progress.visibility = if (newProgress in 1..99) View.VISIBLE else View.GONE
            }
        }

        // Segurar o dedo numa imagem -> "Traduzir esta imagem"
        web.setOnLongClickListener {
            val h = web.hitTestResult
            val src = h.extra
            if ((h.type == WebView.HitTestResult.IMAGE_TYPE ||
                    h.type == WebView.HitTestResult.SRC_IMAGE_ANCHOR_TYPE) && src != null
            ) {
                AlertDialog.Builder(this)
                    .setItems(arrayOf("Traduzir esta imagem")) { _, _ ->
                        cmd("translateSrc", JSONObject.quote(src))
                    }.show()
                true
            } else false
        }

        urlBox.setOnEditorActionListener { _, actionId, event ->
            if (actionId == EditorInfo.IME_ACTION_GO ||
                (event != null && event.keyCode == KeyEvent.KEYCODE_ENTER)
            ) { go(); true } else false
        }
        findViewById<Button>(R.id.go).setOnClickListener { go() }
        findViewById<Button>(R.id.btnTranslate).setOnClickListener { cmd("translateAll") }
        findViewById<Button>(R.id.btnToggle).setOnClickListener { cmd("toggleAll") }
        findViewById<Button>(R.id.btnClear).setOnClickListener { cmd("clear") }
        findViewById<Button>(R.id.btnSettings).setOnClickListener { showSettings() }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (web.canGoBack()) web.goBack() else { isEnabled = false; onBackPressedDispatcher.onBackPressed() }
            }
        })

        if (savedInstanceState != null) web.restoreState(savedInstanceState)
        else web.loadUrl(intent?.data?.toString() ?: "https://www.google.com")
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    override fun onDestroy() {
        pool.shutdownNow()
        super.onDestroy()
    }

    // ---------- navegação ----------
    private fun go() {
        val t = urlBox.text.toString().trim()
        if (t.isEmpty()) return
        val u = when {
            Regex("^https?://", RegexOption.IGNORE_CASE).containsMatchIn(t) -> t
            !t.contains(" ") && t.contains(".") -> "https://$t"
            else -> "https://www.google.com/search?q=" + URLEncoder.encode(t, "UTF-8")
        }
        web.loadUrl(u)
        urlBox.clearFocus()
        (getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager)
            .hideSoftInputFromWindow(urlBox.windowToken, 0)
    }

    private fun cmd(type: String, argJs: String = "null") {
        web.evaluateJavascript("window.__pitCmd&&window.__pitCmd('$type',$argJs)", null)
    }

    // ---------- ajustes ----------
    private fun hostNow(): String? = try { Uri.parse(web.url).host } catch (_: Exception) { null }

    private fun showSettings() {
        val pad = (16 * resources.displayMetrics.density).toInt()
        val box = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(pad, pad, pad, 0) }
        val host = hostNow()
        val hosts = JSONObject(prefs.getString("autoHosts", "{}") ?: "{}")

        val auto = CheckBox(this).apply {
            text = "Traduzir automaticamente em ${host ?: "este site"}"
            isChecked = host != null && hosts.optBoolean(host, false)
            isEnabled = host != null
        }
        fun label(t: String) = TextView(this).apply { text = t; setPadding(0, pad / 2, 0, 0) }
        val tSp = Spinner(this).apply {
            adapter = ArrayAdapter(this@MainActivity, android.R.layout.simple_spinner_dropdown_item, targets.map { it.second })
            setSelection(targets.indexOfFirst { it.first == prefs.getString("target", "pt") }.coerceAtLeast(0))
        }
        val sSp = Spinner(this).apply {
            adapter = ArrayAdapter(this@MainActivity, android.R.layout.simple_spinner_dropdown_item, sources.map { it.second })
            setSelection(sources.indexOfFirst { it.first == prefs.getString("source", "auto") }.coerceAtLeast(0))
        }
        val key = EditText(this).apply {
            hint = "helloworld"
            setText(prefs.getString("apiKey", "") ?: "")
            setSingleLine()
        }
        val hint = TextView(this).apply {
            text = "Chave do OCR.space (opcional). Sem chave própria usa a chave pública de teste, com limite baixo. Chave grátis em ocr.space/ocrapi/freekey"
            textSize = 12f
        }
        box.addView(auto)
        box.addView(label("Traduzir para")); box.addView(tSp)
        box.addView(label("Idioma do texto na imagem")); box.addView(sSp)
        box.addView(label("Chave do OCR.space")); box.addView(key); box.addView(hint)

        AlertDialog.Builder(this)
            .setTitle("Ajustes")
            .setView(android.widget.ScrollView(this).apply { addView(box) })
            .setPositiveButton("Salvar") { _, _ ->
                if (host != null) { if (auto.isChecked) hosts.put(host, true) else hosts.remove(host) }
                prefs.edit()
                    .putString("target", targets[tSp.selectedItemPosition].first)
                    .putString("source", sources[sSp.selectedItemPosition].first)
                    .putString("apiKey", key.text.toString().trim())
                    .putString("autoHosts", hosts.toString())
                    .apply()
                cmd("settings")
            }
            .setNegativeButton("Cancelar", null)
            .show()
    }

    // ---------- ponte JS <-> Kotlin ----------
    inner class Bridge {
        @JavascriptInterface
        fun settings(): String = JSONObject()
            .put("target", prefs.getString("target", "pt"))
            .put("source", prefs.getString("source", "auto"))
            .put("apiKey", prefs.getString("apiKey", "") ?: "")
            .put("autoHosts", JSONObject(prefs.getString("autoHosts", "{}") ?: "{}"))
            .toString()

        @JavascriptInterface
        fun cacheGet(key: String): String {
            val f = File(cacheDirPit, key.filter { it.isLetterOrDigit() })
            return try { if (f.exists()) f.readText() else "" } catch (_: Exception) { "" }
        }

        @JavascriptInterface
        fun cacheSet(key: String, value: String) {
            try {
                File(cacheDirPit, key.filter { it.isLetterOrDigit() }).writeText(value)
                val all = cacheDirPit.listFiles()?.sortedBy { it.lastModified() } ?: return
                if (all.size > 150) all.take(all.size - 150).forEach { it.delete() }
            } catch (_: Exception) {}
        }

        // a = url | dataUrl | texto, b e c = parâmetros extras. Resposta chega por window.__pitRes
        @JavascriptInterface
        fun call(id: Int, method: String, a: String, b: String, c: String) {
            pool.execute {
                try {
                    val r = when (method) {
                        "image" -> fetchImage(a, b)
                        "ocr" -> ocr(a, b, c)
                        "translate" -> translate(a, b)
                        else -> throw IllegalArgumentException("método desconhecido")
                    }
                    reply(id, true, r)
                } catch (e: Exception) {
                    reply(id, false, e.message ?: e.javaClass.simpleName)
                }
            }
        }
    }

    private fun reply(id: Int, ok: Boolean, payload: String) {
        runOnUiThread {
            web.evaluateJavascript("window.__pitRes&&window.__pitRes($id,$ok,${JSONObject.quote(payload)})", null)
        }
    }

    private fun read(conn: HttpURLConnection, limit: Int = 25 * 1024 * 1024): ByteArray {
        val code = conn.responseCode
        if (code !in 200..299) throw RuntimeException("HTTP $code")
        val out = ByteArrayOutputStream()
        conn.inputStream.use { ins ->
            val buf = ByteArray(16 * 1024)
            while (true) {
                val n = ins.read(buf)
                if (n < 0) break
                out.write(buf, 0, n)
                if (out.size() > limit) throw RuntimeException("Imagem grande demais")
            }
        }
        return out.toByteArray()
    }

    // Baixa a imagem com Referer + cookies do WebView (só em memória)
    private fun fetchImage(url: String, referer: String): String {
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.connectTimeout = 15000
        conn.readTimeout = 30000
        conn.setRequestProperty("User-Agent", userAgent)
        conn.setRequestProperty("Accept", "image/*,*/*;q=0.8")
        if (referer.isNotEmpty()) conn.setRequestProperty("Referer", referer)
        CookieManager.getInstance().getCookie(url)?.let { conn.setRequestProperty("Cookie", it) }
        try {
            val bytes = try { read(conn) } catch (e: RuntimeException) {
                throw RuntimeException("Não consegui ler a imagem (${e.message})")
            }
            val mime = (conn.contentType ?: "image/jpeg").substringBefore(';').trim()
            return mime + "|" + Base64.encodeToString(bytes, Base64.NO_WRAP)
        } finally {
            conn.disconnect()
        }
    }

    private fun ocr(dataUrl: String, apiKey: String, langEngine: String): String {
        val (lang, eng) = langEngine.split("|")
        fun e(s: String) = URLEncoder.encode(s, "UTF-8")
        val body = "apikey=${e(apiKey)}&language=${e(lang)}&isOverlayRequired=true&OCREngine=$eng" +
            "&scale=true&base64Image=${e(dataUrl)}"
        val conn = URL("https://api.ocr.space/parse/image").openConnection() as HttpURLConnection
        conn.requestMethod = "POST"
        conn.doOutput = true
        conn.connectTimeout = 20000
        conn.readTimeout = 60000
        conn.setRequestProperty("Content-Type", "application/x-www-form-urlencoded")
        try {
            conn.outputStream.use { it.write(body.toByteArray()) }
            return try { String(read(conn)) } catch (e: RuntimeException) {
                throw RuntimeException("OCR indisponível (${e.message})")
            }
        } finally {
            conn.disconnect()
        }
    }

    private fun translate(text: String, tl: String): String {
        val u = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&dt=t&tl=" +
            URLEncoder.encode(tl, "UTF-8") + "&q=" + URLEncoder.encode(text, "UTF-8")
        val conn = URL(u).openConnection() as HttpURLConnection
        conn.connectTimeout = 15000
        conn.readTimeout = 30000
        try {
            return try { String(read(conn)) } catch (e: RuntimeException) {
                throw RuntimeException("Tradução indisponível (${e.message})")
            }
        } finally {
            conn.disconnect()
        }
    }
}
