package io.github.teampitcrew.gachitamap;

import android.app.Activity;
import android.graphics.Color;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import android.view.Gravity;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import ai.pleos.playground.navi.data.CurrentLocationInfo;
import ai.pleos.playground.navi.helper.NaviHelper;
import ai.pleos.playground.navi.helper.listener.NaviHelperEventListener;
import kotlin.Unit;
import org.maplibre.android.MapLibre;
import org.maplibre.android.camera.CameraPosition;
import org.maplibre.android.geometry.LatLng;
import org.maplibre.android.maps.MapView;
import org.maplibre.android.maps.MapLibreMap;
import org.maplibre.android.style.layers.CircleLayer;
import org.maplibre.android.style.sources.GeoJsonSource;
import org.maplibre.geojson.Feature;
import org.maplibre.geojson.Point;
import static org.maplibre.android.style.layers.PropertyFactory.*;

/** 공개 도로 지도와 Pleos 위치만 표시한다. 순정 내비 인증이나 경로 안내 성공을 주장하지 않는다. */
public class MapActivity extends Activity {
    private static final String EMPTY = "{\"type\":\"FeatureCollection\",\"features\":[]}";
    private final Handler main = new Handler(Looper.getMainLooper());
    private MapView view;
    private NaviHelper navi;
    private TextView status;
    private MapLibreMap map;
    private LatLng last;
    private boolean connected, following = true, destroyed;
    private long locationAt;
    private final Runnable poll = new Runnable() {
        public void run() {
            if (connected) try { navi.getCurrentLocationInfo(); } catch (Exception e) { status.setText("차량 위치 연결을 확인해 주세요"); }
            if (locationAt > 0 && SystemClock.elapsedRealtime() - locationAt > 10000) {
                last = null;
                status.setText("위치 연결을 확인하고 있어요");
                if (map != null && map.getStyle() != null) {
                    GeoJsonSource source = map.getStyle().getSourceAs("car-position");
                    if (source != null) source.setGeoJson(EMPTY);
                }
            }
            main.postDelayed(this, 2000);
        }
    };
    private final NaviHelperEventListener listener = new NaviHelperEventListener() {
        public void onCurrentLocationInfo(CurrentLocationInfo value) {
            main.post(() -> {
                if (destroyed) return;
                double lat = value.getLatitude(), lon = value.getLongitude();
                if (!Double.isFinite(lat) || !Double.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || lat == 0 && lon == 0) return;
                last = new LatLng(lat, lon); locationAt = SystemClock.elapsedRealtime();
                status.setText("차량 위치 연결됨"); position();
            });
        }
    };
    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved); MapLibre.getInstance(this);
        FrameLayout root = new FrameLayout(this);
        view = new MapView(this); view.onCreate(saved);
        root.addView(view, new FrameLayout.LayoutParams(-1, -1));
        LinearLayout head = new LinearLayout(this); head.setOrientation(LinearLayout.VERTICAL);
        head.setPadding(dp(24), dp(18), dp(24), dp(18)); head.setBackgroundColor(Color.WHITE);
        TextView title = text("함께 가는 길", 32); title.setTypeface(null, 1); head.addView(title);
        status = text("차량 위치를 확인하고 있어요", 22); head.addView(status);
        root.addView(head, new FrameLayout.LayoutParams(-1, -2, Gravity.TOP));
        Button recenter = new Button(this); recenter.setText("현재 위치"); recenter.setTextSize(24);
        recenter.setOnClickListener(v -> { following = true; position(); });
        FrameLayout.LayoutParams button = new FrameLayout.LayoutParams(dp(145), dp(58), Gravity.BOTTOM | Gravity.END);
        button.bottomMargin = dp(104); button.rightMargin = dp(20); root.addView(recenter, button);
        TextView note = text("공개 도로 지도 · 경로 안내 미연결", 20);
        note.setPadding(dp(18), dp(12), dp(18), dp(12)); note.setBackgroundColor(Color.WHITE);
        FrameLayout.LayoutParams footer = new FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM); footer.bottomMargin = dp(34);
        root.addView(note, footer); setContentView(root);
        view.addOnDidFailLoadingMapListener(error -> { Log.w("GachitaMap", "Map load failed"); status.setText("지도를 불러오지 못했어요 · 연결을 확인해 주세요"); });
        view.addOnDidFinishRenderingMapListener(full -> { if (full) Log.i("GachitaMap", "도로 지도 렌더 완료"); });
        view.getMapAsync(m -> {
            map = m;
            // 위치 수신 전에는 한국 전체를 표시하고 현재 위치 마커를 만들지 않는다.
            m.setCameraPosition(new CameraPosition.Builder().target(new LatLng(36.5, 127.7)).zoom(6).build());
            m.addOnCameraMoveStartedListener(reason -> { if (reason == MapLibreMap.OnCameraMoveStartedListener.REASON_API_GESTURE) following = false; });
            m.setStyle("https://tiles.openfreemap.org/styles/liberty", style -> {
                style.addSource(new GeoJsonSource("car-position", EMPTY));
                style.addLayer(new CircleLayer("car-position", "car-position").withProperties(circleRadius(11f), circleColor("#237B59"), circleStrokeColor("#FFFFFF"), circleStrokeWidth(4f)));
                position();
            });
        });
        navi = new NaviHelper(getApplicationContext());
        navi.initialize(() -> { main.post(() -> { if (!destroyed) { connected = true; navi.addListener(listener); navi.getCurrentLocationInfo(); } }); return Unit.INSTANCE; }, error -> { main.post(() -> { if (!destroyed) status.setText("차량 위치 연결을 확인해 주세요"); }); return Unit.INSTANCE; });
    }
    private TextView text(String value, float size) { TextView t = new TextView(this); t.setText(value); t.setTextSize(size); t.setTextColor(Color.rgb(43, 64, 53)); return t; }
    private void position() {
        if (map == null || last == null || destroyed) return;
        if (map.getStyle() != null) {
            GeoJsonSource source = map.getStyle().getSourceAs("car-position");
            if (source != null) source.setGeoJson(Feature.fromGeometry(Point.fromLngLat(last.getLongitude(), last.getLatitude())));
        }
        if (following) map.setCameraPosition(new CameraPosition.Builder().target(last).zoom(15.5).build());
    }
    private int dp(int value) { return (int)(getResources().getDisplayMetrics().density * value); }
    @Override public void onStart() { super.onStart(); view.onStart(); main.post(poll); }
    @Override public void onResume() { super.onResume(); view.onResume(); }
    @Override public void onPause() { view.onPause(); super.onPause(); }
    @Override public void onStop() { main.removeCallbacks(poll); view.onStop(); super.onStop(); }
    @Override public void onDestroy() { destroyed = true; main.removeCallbacksAndMessages(null); try { navi.removeListener(listener); navi.release(); } catch (Exception ignored) {} view.onDestroy(); super.onDestroy(); }
    @Override public void onSaveInstanceState(Bundle state) { super.onSaveInstanceState(state); view.onSaveInstanceState(state); }
    @Override public void onLowMemory() { super.onLowMemory(); view.onLowMemory(); }
}
