use tray_icon::Icon;

const SIZE: u32 = 32;

#[derive(Clone, Copy)]
pub enum Tone {
    Running,
    Stopped,
    Waiting,
}

impl Tone {
    fn rgb(self) -> [u8; 3] {
        match self {
            Tone::Running => [46, 160, 67],
            Tone::Stopped => [128, 128, 128],
            Tone::Waiting => [219, 150, 24],
        }
    }
}

pub fn make(tone: Tone) -> Icon {
    let [r, g, b] = tone.rgb();
    let center = (SIZE as f32 - 1.0) / 2.0;
    let radius = SIZE as f32 / 2.0 - 1.5;
    let mut rgba = Vec::with_capacity((SIZE * SIZE * 4) as usize);
    for y in 0..SIZE {
        for x in 0..SIZE {
            let distance = ((x as f32 - center).powi(2) + (y as f32 - center).powi(2)).sqrt();
            let coverage = (radius + 0.5 - distance).clamp(0.0, 1.0);
            let ring = distance > radius - 3.0;
            let shade = if ring { 0.75 } else { 1.0 };
            rgba.extend_from_slice(&[
                (r as f32 * shade) as u8,
                (g as f32 * shade) as u8,
                (b as f32 * shade) as u8,
                (coverage * 255.0) as u8,
            ]);
        }
    }
    Icon::from_rgba(rgba, SIZE, SIZE).expect("icon dimensions match buffer")
}
