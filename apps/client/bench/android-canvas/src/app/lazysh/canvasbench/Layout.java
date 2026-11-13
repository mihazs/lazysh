package app.lazysh.canvasbench;

import java.io.DataInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.BufferedInputStream;
import java.nio.charset.StandardCharsets;

/** Frames of draws written by the Rust example dump_layout (`LZL1`, see its header for the format). */
final class Layout {
    static final class Frame {
        byte[] tag;
        int[] x, y, w, h, color, cells;
        boolean[] bold;
        String[] text;
    }

    final int cols, rows, cellW, cellH;
    final Frame[] frames;

    Layout(InputStream stream) throws IOException {
        try (DataInputStream in = new DataInputStream(new BufferedInputStream(stream, 1 << 16))) {
            byte[] magic = new byte[4];
            in.readFully(magic);
            if (!new String(magic, StandardCharsets.US_ASCII).equals("LZL1")) throw new IOException("not a layout file");
            cols = in.readUnsignedShort();
            rows = in.readUnsignedShort();
            cellW = in.readUnsignedShort();
            cellH = in.readUnsignedShort();
            frames = new Frame[in.readInt()];
            for (int f = 0; f < frames.length; f++) {
                int n = in.readInt();
                Frame fr = frames[f] = new Frame();
                fr.tag = new byte[n];
                fr.x = new int[n]; fr.y = new int[n]; fr.w = new int[n]; fr.h = new int[n];
                fr.color = new int[n]; fr.cells = new int[n];
                fr.bold = new boolean[n];
                fr.text = new String[n];
                for (int i = 0; i < n; i++) {
                    fr.tag[i] = in.readByte();
                    fr.x[i] = in.readUnsignedShort();
                    fr.y[i] = in.readUnsignedShort();
                    if (fr.tag[i] == 0) {
                        fr.w[i] = in.readUnsignedShort();
                        fr.h[i] = in.readUnsignedShort();
                    } else {
                        fr.cells[i] = in.readUnsignedByte();
                        fr.bold[i] = in.readUnsignedByte() != 0;
                    }
                    fr.color[i] = 0xff000000 | in.readUnsignedByte() << 16 | in.readUnsignedByte() << 8 | in.readUnsignedByte();
                    if (fr.tag[i] == 1) {
                        byte[] bytes = new byte[in.readUnsignedByte()];
                        in.readFully(bytes);
                        fr.text[i] = new String(bytes, StandardCharsets.UTF_8);
                    }
                }
            }
        }
    }
}
