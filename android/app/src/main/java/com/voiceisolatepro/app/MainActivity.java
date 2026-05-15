package com.voiceisolatepro.app;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.webkit.ServiceWorkerClient;
import android.webkit.ServiceWorkerController;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;

import java.util.HashMap;
import java.util.Map;

public class MainActivity extends BridgeActivity {

    private static final int REQUEST_CODE_RECORD_AUDIO = 1001;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        requestMicPermissionIfNeeded();
        setupCrossOriginIsolation();
    }

    private void requestMicPermissionIfNeeded() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(
                    this,
                    new String[]{Manifest.permission.RECORD_AUDIO},
                    REQUEST_CODE_RECORD_AUDIO
            );
        }
    }

    /**
     * SharedArrayBuffer requires cross-origin isolation:
     *   Cross-Origin-Opener-Policy: same-origin
     *   Cross-Origin-Embedder-Policy: require-corp
     *
     * Capacitor's WebViewClient does NOT inject these headers when serving
     * local assets, so SAB is permanently disabled unless we intercept every
     * response and inject them ourselves.
     *
     * We also hook the ServiceWorkerController so that sw.js — which controls
     * the page scope — also runs in a cross-origin isolated context.
     */
    private void setupCrossOriginIsolation() {
        WebView webView = getBridge().getWebView();

        // ── 1. Main-frame + subresource header injection ──────────────────────
        webView.setWebViewClient(new BridgeWebViewClient(getBridge()) {
            @Override
            public WebResourceResponse shouldInterceptRequest(
                    WebView view, WebResourceRequest request) {

                // Let Capacitor handle the actual resource fetch first
                WebResourceResponse response =
                        super.shouldInterceptRequest(view, request);

                if (response == null) return null;

                // Inject cross-origin isolation headers into every response
                return injectIsolationHeaders(response);
            }
        });

        // ── 2. Service Worker header injection (Android 8.0+ / API 26+) ──────
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            ServiceWorkerController swController =
                    ServiceWorkerController.getInstance();
            swController.setServiceWorkerClient(new ServiceWorkerClient() {
                @Override
                public WebResourceResponse shouldInterceptRequest(
                        WebResourceRequest request) {
                    // Null = let the SW fetch proceed normally;
                    // we can't inject headers here directly, but registering
                    // this client causes the SW to inherit the page's COEP
                    // context which is sufficient for SAB availability.
                    return null;
                }
            });
        }
    }

    /**
     * Returns a new WebResourceResponse with COOP + COEP headers merged in.
     * Preserves all existing headers from the original response.
     */
    private WebResourceResponse injectIsolationHeaders(WebResourceResponse original) {
        // Build merged header map: start with whatever Capacitor already set
        Map<String, String> headers = new HashMap<>();
        if (original.getResponseHeaders() != null) {
            headers.putAll(original.getResponseHeaders());
        }

        // These two headers together create the cross-origin isolated context
        // that enables SharedArrayBuffer + Atomics on Android WebView.
        headers.put("Cross-Origin-Opener-Policy",   "same-origin");
        headers.put("Cross-Origin-Embedder-Policy",  "require-corp");
        // CORP on all same-origin resources so they're embeddable under COEP
        headers.put("Cross-Origin-Resource-Policy",  "same-origin");

        return new WebResourceResponse(
                original.getMimeType(),
                original.getEncoding(),
                original.getStatusCode(),
                original.getReasonPhrase(),
                headers,
                original.getData()
        );
    }
}
