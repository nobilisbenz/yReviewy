fn main() {
    let icon_path = std::path::Path::new("icons/icon.png");
    if !icon_path.exists() {
        std::fs::create_dir_all(icon_path.parent().unwrap()).unwrap();
        let file = std::fs::File::create(icon_path).unwrap();
        let mut encoder = png::Encoder::new(file, 512, 512);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().unwrap();
        let mut pixels = vec![0_u8; 512 * 512 * 4];
        for y in 0..512 {
            for x in 0..512 {
                let offset = (y * 512 + x) * 4;
                let leaf = ((x as i32 - 256).pow(2) + (y as i32 - 250).pow(2)) < 175_i32.pow(2)
                    || (x > 245 && x < 270 && y > 225 && y < 440);
                let color = if leaf {
                    [244, 207, 119, 255]
                } else {
                    [23, 63, 52, 255]
                };
                pixels[offset..offset + 4].copy_from_slice(&color);
            }
        }
        writer.write_image_data(&pixels).unwrap();
    }
    tauri_build::build()
}
