use glib::prelude::Cast;
use x11rb::{
    connection::Connection, protocol::xproto::*, rust_connection::RustConnection,
    COPY_DEPTH_FROM_PARENT,
};

pub struct X11Surface {
    conn: RustConnection,
    win: u32,
}

impl X11Surface {
    pub fn new(gdk: &gdk::Window, color: u32) -> Self {
        let parent = gdk
            .downcast_ref::<gdkx11::X11Window>()
            .expect("x11 window")
            .xid() as u32;
        let (conn, _) = RustConnection::connect(None).expect("x11 connect");
        let win = conn.generate_id().unwrap();
        conn.create_window(
            COPY_DEPTH_FROM_PARENT,
            win,
            parent,
            0,
            0,
            10,
            10,
            0,
            WindowClass::INPUT_OUTPUT,
            0,
            &CreateWindowAux::new().background_pixel(color & 0xffffff),
        )
        .unwrap();
        conn.map_window(win).unwrap();
        conn.flush().unwrap();
        Self { conn, win }
    }
}
impl super::Surface for X11Surface {
    fn place(&mut self, x: i32, y: i32, w: i32, h: i32) {
        self.conn
            .configure_window(
                self.win,
                &ConfigureWindowAux::new()
                    .x(x)
                    .y(y)
                    .width(w as u32)
                    .height(h as u32),
            )
            .unwrap();
        self.conn.flush().unwrap();
    }
}
impl Drop for X11Surface {
    fn drop(&mut self) {
        let _ = self.conn.destroy_window(self.win);
        let _ = self.conn.flush();
    }
}
