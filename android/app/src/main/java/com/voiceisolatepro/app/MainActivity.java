package com.voiceisolatepro.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;

import androidx.annotation.Nullable;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.webkit.WebViewAssetLoader;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;

import java.io.IOException;
import java.io.InputStream;
import java.io.UnsupportedEncodingException;
import java.net.URLConnection;
import java.net.URLDecoder;
import java.util.HashMap;
import java.util.Map;

/**
 * VoiceIsolate Pro — Capacitor host.
 *
 * Critical Android WebView fixes:
 *  1. COOP/COEP headers so SharedArrayBuffer / ORT threaded WASM can enable
 *  2. Correct MIME for .js / .mjs / .wasm (AudioWorklet + Workers + ORT)
 *  3. Safe WebResourceResponse reconstruction (null status/reason crashes many devices)
 *  4. Strip query/fragment from asset paths so ?cacheBust= loads still hit disk
 */
public class MainActivity extends BridgeActivity {
    private static final String TAG = "VIPMainActivity";
    private static final int REQUEST_READ_MEDIA = 1002;
    private static final String ASSET_PATH_PREFIX = "public";
    /** One COOP/COEP reload per process — avoids stacked freezes on activity recreate. */
    private static boolean sIsolationReloadDone = false;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Upload-only product: the manifest does not request RECORD_AUDIO.
        // Media-read is deferred until after first content paint (see scheduleDeferredMediaPermission).
        // Bridge WebView is ready after super.onCreate — wire isolation + MIME.
        try {
            setupWebViewHardening();
        } catch (Throwable t) {
            Log.e(TAG, "WebView hardening failed — app may run without SAB", t);
        }
    }

    private void requestReadMediaPermissionIfNeeded() {
        try {
            if (Build.VERSION.SDK_INT >= 33) {
                if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_MEDIA_AUDIO)
                        != PackageManager.PERMISSION_GRANTED) {
                    ActivityCompat.requestPermissions(
                            this,
                            new String[]{Manifest.permission.READ_MEDIA_AUDIO},
                            REQUEST_READ_MEDIA
                    );
                }
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_EXTERNAL_STORAGE)
                        != PackageManager.PERMISSION_GRANTED) {
                    ActivityCompat.requestPermissions(
                            this,
                            new String[]{Manifest.permission.READ_EXTERNAL_STORAGE},
                            REQUEST_READ_MEDIA
                    );
                }
            }
        } catch (Throwable t) {
            Log.w(TAG, "READ_MEDIA permission request skipped", t);
        }
    }

    /** Ask for media access after UI is interactive — never block first paint. */
    private void scheduleDeferredMediaPermission(WebView webView) {
        try {
            webView.postDelayed(this::requestReadMediaPermissionIfNeeded, 1800);
        } catch (Throwable t) {
            Log.w(TAG, "Deferred media permission schedule failed", t);
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void setupWebViewHardening() {
        Bridge bridge = getBridge();
        if (bridge == null) {
            Log.e(TAG, "Bridge is null after onCreate");
            return;
        }
        WebView webView = bridge.getWebView();
        if (webView == null) {
            Log.e(TAG, "WebView is null after onCreate");
            return;
        }

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        // Large local models + OfflineAudioContext need generous cache / file access.
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            settings.setSafeBrowsingEnabled(false);
        }
        // Debug sideload builds: chrome://inspect for WebView.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        final WebViewAssetLoader assetLoader = new WebViewAssetLoader.Builder()
                .setDomain("voiceisolatepro.app")
                .setHttpAllowed(false)
                .addPathHandler("/", new PublicAssetPathHandler())
                .build();

        webView.setWebViewClient(new BridgeWebViewClient(bridge) {
            @Override
            public WebResourceResponse shouldInterceptRequest(
                    WebView view, WebResourceRequest request) {
                try {
                    if (request != null && request.getUrl() != null) {
                        WebResourceResponse assetResponse =
                                assetLoader.shouldInterceptRequest(request.getUrl());
                        if (assetResponse != null) {
                            return injectIsolationHeaders(assetResponse, request.getUrl().getPath());
                        }
                    }
                    WebResourceResponse response =
                            super.shouldInterceptRequest(view, request);
                    if (response == null) return null;
                    String path = request != null && request.getUrl() != null
                            ? request.getUrl().getPath() : null;
                    return injectIsolationHeaders(response, path);
                } catch (Throwable t) {
                    Log.e(TAG, "shouldInterceptRequest failed", t);
                    try {
                        return super.shouldInterceptRequest(view, request);
                    } catch (Throwable ignored) {
                        return null;
                    }
                }
            }
        });

        // BridgeActivity starts the first navigation during super.onCreate() with the
        // default WebViewClient (no COOP/COEP). Reload once per process after our
        // interceptor is installed so document + workers get isolation headers.
        // Skip repeat reloads on configuration changes — they freeze the WebView.
        // Many Android WebViews still omit SharedArrayBuffer; JS falls back (vip-boot).
        if (!sIsolationReloadDone) {
            sIsolationReloadDone = true;
            try {
                webView.post(() -> {
                    try {
                        Log.i(TAG, "Reloading WebView once so COOP/COEP apply to document load");
                        webView.reload();
                    } catch (Throwable t) {
                        Log.w(TAG, "WebView reload after header injection failed", t);
                    }
                    scheduleDeferredMediaPermission(webView);
                });
            } catch (Throwable t) {
                Log.w(TAG, "Could not schedule WebView reload", t);
                scheduleDeferredMediaPermission(webView);
            }
        } else {
            scheduleDeferredMediaPermission(webView);
        }
    }

    /**
     * Rebuild the response with COOP/COEP/CORP. Never pass null/invalid status
     * into the 6-arg WebResourceResponse constructor (crashes on many devices).
     */
    private WebResourceResponse injectIsolationHeaders(
            WebResourceResponse original, @Nullable String pathHint) {
        if (original == null) return null;
        try {
            Map<String, String> headers = new HashMap<>();
            if (original.getResponseHeaders() != null) {
                headers.putAll(original.getResponseHeaders());
            }
            headers.put("Cross-Origin-Opener-Policy", "same-origin");
            headers.put("Cross-Origin-Embedder-Policy", "require-corp");
            headers.put("Cross-Origin-Resource-Policy", "same-origin");
            // Cache static assets for snappier offline navigation.
            headers.put("Cache-Control", "public, max-age=86400");

            String mime = original.getMimeType();
            if (mime == null || mime.isEmpty() || "text/plain".equals(mime)) {
                mime = mimeTypeForAsset(pathHint != null ? pathHint : "");
            }
            String encoding = original.getEncoding();
            // Binary types must not force a charset.
            if (mime != null && (mime.contains("wasm")
                    || mime.contains("octet-stream")
                    || mime.contains("onnx"))) {
                encoding = null;
            } else if (encoding == null || encoding.isEmpty()) {
                encoding = "UTF-8";
            }

            int status = 200;
            String reason = "OK";
            try {
                int s = original.getStatusCode();
                if (s >= 100 && s <= 599) status = s;
            } catch (Throwable ignored) { /* 3-arg responses */ }
            try {
                String r = original.getReasonPhrase();
                if (r != null && !r.isEmpty()) reason = r;
            } catch (Throwable ignored) { /* 3-arg responses */ }

            InputStream data = original.getData();
            return new WebResourceResponse(
                    mime,
                    encoding,
                    status,
                    reason,
                    headers,
                    data
            );
        } catch (Throwable t) {
            Log.e(TAG, "injectIsolationHeaders failed — returning original", t);
            return original;
        }
    }

    private final class PublicAssetPathHandler implements WebViewAssetLoader.PathHandler {
        @Override
        @Nullable
        public WebResourceResponse handle(String path) {
            try {
                path = normalizeAssetPath(path);
                final String assetPath = ASSET_PATH_PREFIX + path;
                InputStream is = getAssets().open(assetPath);
                String mimeType = mimeTypeForAsset(assetPath);
                // Use 3-arg ctor; injectIsolationHeaders upgrades safely.
                return new WebResourceResponse(mimeType, "UTF-8", is);
            } catch (IOException e) {
                // Directory indexes: try …/index.html
                try {
                    String fallback = normalizeAssetPath(path);
                    if (!fallback.endsWith(".html") && !fallback.contains(".")) {
                        if (!fallback.endsWith("/")) fallback = fallback + "/";
                        fallback = fallback + "index.html";
                        InputStream is = getAssets().open(ASSET_PATH_PREFIX + fallback);
                        return new WebResourceResponse("text/html", "UTF-8", is);
                    }
                } catch (IOException ignored) { /* fall through */ }
                Log.w(TAG, "Asset miss: " + path);
                return null;
            }
        }
    }

    /** Strip query/fragment, decode, ensure leading slash, map "" → /index.html */
    private static String normalizeAssetPath(@Nullable String path) {
        if (path == null || path.isEmpty() || "/".equals(path)) {
            return "/index.html";
        }
        int q = path.indexOf('?');
        if (q >= 0) path = path.substring(0, q);
        int h = path.indexOf('#');
        if (h >= 0) path = path.substring(0, h);
        try {
            path = URLDecoder.decode(path, "UTF-8");
        } catch (UnsupportedEncodingException ignored) { /* UTF-8 always present */ }
        if (!path.startsWith("/")) {
            path = "/" + path;
        }
        // Collapse accidental double slashes
        while (path.contains("//")) {
            path = path.replace("//", "/");
        }
        return path;
    }

    private static String mimeTypeForAsset(String assetPath) {
        String lower = assetPath == null ? "" : assetPath.toLowerCase();
        if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) {
            return "application/javascript";
        }
        if (lower.endsWith(".wasm")) {
            return "application/wasm";
        }
        if (lower.endsWith(".onnx")) {
            return "application/octet-stream";
        }
        if (lower.endsWith(".json")) {
            return "application/json";
        }
        if (lower.endsWith(".css")) {
            return "text/css";
        }
        if (lower.endsWith(".html") || lower.endsWith(".htm")) {
            return "text/html";
        }
        if (lower.endsWith(".svg")) {
            return "image/svg+xml";
        }
        if (lower.endsWith(".png")) {
            return "image/png";
        }
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
            return "image/jpeg";
        }
        if (lower.endsWith(".woff2")) {
            return "font/woff2";
        }
        if (lower.endsWith(".mp4") || lower.endsWith(".webm")) {
            return "video/mp4";
        }
        String guessed = URLConnection.guessContentTypeFromName(assetPath);
        return guessed != null ? guessed : "application/octet-stream";
    }
}
