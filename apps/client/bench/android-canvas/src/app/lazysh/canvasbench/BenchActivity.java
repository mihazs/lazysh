package app.lazysh.canvasbench;

import android.app.Activity;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Typeface;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.Log;
import android.view.Choreographer;
import android.view.FrameMetrics;
import android.view.View;
import android.view.Window;
import android.view.ViewGroup;
import android.view.WindowManager;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * Replays the shared terminal layout (Rust `layout::row_draws`) with the Android Canvas API for the
 * renderer shootout (#1323): first on a software Bitmap canvas, then through the hardware pipeline of
 * a real window with FrameMetrics. Results go to logcat, tag LazyshCanvasBench. Reads
 * the layouts from the APK's assets/layouts (build.sh's optional fourth argument); not part of the app.
 */
public final class BenchActivity extends Activity {
    static final String TAG = "LazyshCanvasBench";
    static final int SOFT_FRAMES = 3000, VIEW_FRAMES = 900;

    /**
     * Draws one frame of a layout. As-is replays every draw in order, one Canvas call each. Tuned does what
     * a Canvas terminal does: clears to the theme background, fills only non-default backgrounds (merging
     * neighbours of one color), draws narrow glyphs as one text run per color and weight, then decorations.
     */
    static final class Replayer {
        final Layout layout;
        final Paint fill = new Paint(), text = new Paint(Paint.ANTI_ALIAS_FLAG);
        final boolean tuned;
        long calls;

        Replayer(Layout layout, boolean tuned) {
            this.layout = layout;
            this.tuned = tuned;
            text.setTypeface(Typeface.MONOSPACE);
            text.setTextSize(13f);
            // Make a monospace advance equal the cell width, as a canvas terminal does to stay on the grid.
            text.setTextScaleX(layout.cellW / text.measureText("X"));
        }

        void rect(Canvas canvas, Layout.Frame f, int i, int right) {
            fill.setColor(f.color[i]);
            canvas.drawRect(f.x[i], f.y[i], right, f.y[i] + f.h[i], fill);
            calls++;
        }

        void glyph(Canvas canvas, Layout.Frame f, int i, CharSequence s, int x) {
            text.setColor(f.color[i]);
            text.setFakeBoldText(f.bold[i]);
            canvas.drawText(s, 0, s.length(), x, f.y[i] + layout.cellH - 4, text);
            calls++;
        }

        void fillRun(Canvas canvas, int y, int left, int right, int color) {
            fill.setColor(color);
            canvas.drawRect(left, y, right, y + layout.cellH, fill);
            calls++;
        }

        boolean isBackground(Layout.Frame f, int i) {
            return f.tag[i] == 0 && f.h[i] == layout.cellH && f.w[i] % layout.cellW == 0;
        }

        boolean narrow(Layout.Frame f, int i) {
            String s = f.text[i];
            return f.cells[i] == 1 && s.length() == 1 && s.charAt(0) >= 0x20 && s.charAt(0) < 0x7f; // ASCII only: other glyphs may come from a fallback font whose advance is not the cell width
        }

        void draw(Canvas canvas, int index) {
            Layout.Frame f = layout.frames[index % layout.frames.length];
            canvas.drawColor(Color.BLACK);
            int n = f.tag.length;
            if (!tuned) {
                for (int i = 0; i < n; i++) {
                    if (f.tag[i] == 0) rect(canvas, f, i, f.x[i] + f.w[i]);
                    else glyph(canvas, f, i, f.text[i], f.x[i]);
                }
                return;
            }
            int rowY = -1, left = 0, right = 0, color = 0, first = -1;
            for (int i = 0; i < n; i++) { // backgrounds: skip the default, merge contiguous cells of one color per row
                if (!isBackground(f, i) || f.color[i] == Color.BLACK) continue;
                if (first >= 0 && f.y[i] == rowY && f.color[i] == color && f.x[i] == right) {
                    right += f.w[i];
                    continue;
                }
                if (first >= 0) fillRun(canvas, rowY, left, right, color);
                first = i; rowY = f.y[i]; left = f.x[i]; right = left + f.w[i]; color = f.color[i];
            }
            if (first >= 0) fillRun(canvas, rowY, left, right, color);
            StringBuilder run = new StringBuilder();
            int start = -1;
            for (int i = 0; i < n; i++) {
                if (f.tag[i] != 1) continue;
                if (narrow(f, i)) {
                    boolean joins = start >= 0 && f.y[i] == f.y[start] && f.color[i] == f.color[start] && f.bold[i] == f.bold[start]
                        && f.x[i] == f.x[start] + run.length() * layout.cellW;
                    if (!joins) {
                        if (start >= 0) glyph(canvas, f, start, run, f.x[start]);
                        run.setLength(0);
                        start = i;
                    }
                    run.append(f.text[i]);
                } else glyph(canvas, f, i, f.text[i], f.x[i]);
            }
            if (start >= 0) glyph(canvas, f, start, run, f.x[start]);
            for (int i = 0; i < n; i++) // decorations: everything that is not a cell background
                if (f.tag[i] == 0 && !isBackground(f, i)) rect(canvas, f, i, f.x[i] + f.w[i]);
        }
    }

    /** The view of a canvas terminal: a full replay of the current frame per onDraw. */
    final class GridView extends View {
        Replayer replayer;
        int frame;
        long[] onDrawNs = new long[VIEW_FRAMES + 64];
        int onDrawCount;

        GridView(Context context) {
            super(context);
        }

        @Override
        protected void onDraw(Canvas canvas) {
            if (replayer == null) return;
            long t = System.nanoTime();
            replayer.draw(canvas, frame);
            if (onDrawCount < onDrawNs.length) onDrawNs[onDrawCount++] = System.nanoTime() - t;
        }
    }

    final HandlerThread metricsThread = new HandlerThread("metrics");
    GridView grid;
    /** One run per process: a resume (screen wake) or a second activity instance used to start another run on top of the first. */
    static final java.util.concurrent.atomic.AtomicBoolean STARTED = new java.util.concurrent.atomic.AtomicBoolean();

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        grid = new GridView(this);
        setContentView(grid, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        metricsThread.start();
    }

    @Override
    protected void onResume() {
        super.onResume();
        Log.i(TAG, "resumed, run already started: " + STARTED.get());
        if (!STARTED.compareAndSet(false, true)) return;
        new Thread(this::runAll, "bench").start();
    }

    static String stat(long[] ns, int n) {
        long[] s = Arrays.copyOf(ns, n);
        Arrays.sort(s);
        return String.format("%.3f / %.3f / %.3f", s[n / 2] / 1e6, s[(int) ((n - 1) * 0.99)] / 1e6, s[n - 1] / 1e6);
    }

    void runAll() {
        try {
            Thread.sleep(1500);
            String[] files = getAssets().list("layouts");
            Arrays.sort(files);
            Log.i(TAG, "device " + android.os.Build.MODEL + " sdk " + android.os.Build.VERSION.SDK_INT + " " + android.os.Build.SUPPORTED_ABIS[0]
                + " display " + getResources().getDisplayMetrics().widthPixels + "x" + getResources().getDisplayMetrics().heightPixels
                + " refresh " + getWindowManager().getDefaultDisplay().getRefreshRate());
            Log.i(TAG, "| workload | path | draws in the layout | Canvas calls per frame | p50 / p99 / max ms |");
            for (String file : files) {
                Layout layout = new Layout(getAssets().open("layouts/" + file));
                String name = file.replace(".lzl", "");
                int draws = layout.frames[0].tag.length;
                for (boolean tuned : new boolean[] {false, true}) {
                    String mode = tuned ? "tuned" : "as-is";
                    Replayer soft = new Replayer(layout, tuned);
                    Bitmap bitmap = Bitmap.createBitmap(layout.cols * layout.cellW, layout.rows * layout.cellH, Bitmap.Config.ARGB_8888);
                    Canvas canvas = new Canvas(bitmap);
                    for (int i = 0; i < 300; i++) soft.draw(canvas, i);
                    soft.calls = 0;
                    long[] ns = new long[SOFT_FRAMES];
                    for (int i = 0; i < SOFT_FRAMES; i++) {
                        long t = System.nanoTime();
                        soft.draw(canvas, i);
                        ns[i] = System.nanoTime() - t;
                    }
                    if (bitmap.getPixel(2, 2) == 0) throw new IllegalStateException("bitmap not painted");
                    if (tuned) Log.i(TAG, "| " + name + " | tuned against as-is, pixels that differ in 8 frames | | | " + differing(layout, soft) + " |");
                    Log.i(TAG, "| " + name + " | software Bitmap canvas, " + mode + " | " + draws + " | "
                        + soft.calls / SOFT_FRAMES + " | " + stat(ns, SOFT_FRAMES) + " |");
                    viewRun(name, layout, tuned, mode, draws);
                }
            }
            Log.i(TAG, "done");
        } catch (Throwable t) {
            Log.e(TAG, "failed", t);
        }
    }

    /** Share of pixels, over a few frames, where the tuned replay differs from the as-is one. */
    static String differing(Layout layout, Replayer tuned) {
        int w = layout.cols * layout.cellW, h = layout.rows * layout.cellH;
        Bitmap a = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888), b = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
        Replayer plain = new Replayer(layout, false);
        long bad = 0, painted = 0;
        int[] pa = new int[w * h], pb = new int[w * h];
        for (int frame = 0; frame < 8; frame++) {
            plain.draw(new Canvas(a), frame * 7);
            tuned.draw(new Canvas(b), frame * 7);
            a.getPixels(pa, 0, w, 0, 0, w, h);
            b.getPixels(pb, 0, w, 0, 0, w, h);
            for (int i = 0; i < pa.length; i++) {
                if (pa[i] != pb[i]) bad++;
                if (pa[i] != Color.BLACK) painted++;
            }
        }
        if (painted == 0) throw new IllegalStateException("nothing painted");
        return String.format("%.3f %% of all pixels, %.2f %% of the non-black ones", 100.0 * bad / (8.0 * w * h), 100.0 * bad / painted);
    }

    void viewRun(String name, Layout layout, boolean tuned, String mode, int draws) throws Exception {
        long[] total = new long[VIEW_FRAMES], draw = new long[VIEW_FRAMES], issue = new long[VIEW_FRAMES], gpu = new long[VIEW_FRAMES];
        int[] seen = {0};
        Object lock = new Object();
        Window.OnFrameMetricsAvailableListener listener = (window, metrics, dropped) -> {
            synchronized (lock) {
                if (seen[0] >= VIEW_FRAMES) return;
                int i = seen[0]++;
                total[i] = metrics.getMetric(FrameMetrics.TOTAL_DURATION);
                draw[i] = metrics.getMetric(FrameMetrics.DRAW_DURATION);
                issue[i] = metrics.getMetric(FrameMetrics.COMMAND_ISSUE_DURATION);
                gpu[i] = metrics.getMetric(FrameMetrics.GPU_DURATION);
                if (seen[0] == VIEW_FRAMES) lock.notifyAll();
            }
        };
        Handler handler = new Handler(metricsThread.getLooper());
        grid.post(() -> {
            grid.replayer = new Replayer(layout, tuned);
            grid.onDrawCount = 0;
            getWindow().addOnFrameMetricsAvailableListener(listener, handler);
            Choreographer.getInstance().postFrameCallback(new Choreographer.FrameCallback() {
                @Override
                public void doFrame(long nanos) {
                    if (seen[0] >= VIEW_FRAMES) return;
                    grid.frame++;
                    grid.invalidate();
                    Choreographer.getInstance().postFrameCallback(this);
                }
            });
        });
        synchronized (lock) {
            long deadline = System.currentTimeMillis() + 60_000;
            while (seen[0] < VIEW_FRAMES && System.currentTimeMillis() < deadline) lock.wait(1000);
        }
        grid.post(() -> getWindow().removeOnFrameMetricsAvailableListener(listener));
        int n = Math.min(seen[0], VIEW_FRAMES);
        if (n < 100) throw new IllegalStateException("only " + n + " frames measured");
        int skip = 30; // drop warm-up frames
        long[] t = Arrays.copyOfRange(total, skip, n), d = Arrays.copyOfRange(draw, skip, n), c = Arrays.copyOfRange(issue, skip, n), g = Arrays.copyOfRange(gpu, skip, n);
        long[] od = Arrays.copyOfRange(grid.onDrawNs, skip, Math.min(grid.onDrawCount, grid.onDrawNs.length));
        long janky = Arrays.stream(t).filter(v -> v > 16_700_000L).count();
        String prefix = "| " + name + " | window, hardware pipeline, " + mode + " | " + draws + " | ";
        Log.i(TAG, prefix + "- | onDraw (record) " + stat(od, od.length) + " |");
        Log.i(TAG, prefix + "- | FrameMetrics DRAW_DURATION " + stat(d, d.length) + " |");
        Log.i(TAG, prefix + "- | FrameMetrics COMMAND_ISSUE_DURATION " + stat(c, c.length) + " |");
        Log.i(TAG, prefix + "- | FrameMetrics GPU_DURATION " + stat(g, g.length) + " |");
        Log.i(TAG, prefix + "- | FrameMetrics TOTAL_DURATION " + stat(t, t.length) + " (" + janky + " of " + t.length + " over 16.7 ms) |");
    }
}
