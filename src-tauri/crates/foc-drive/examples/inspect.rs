use anyhow::Result;
use foc_drive::Link;

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    let mut link = Link::default();
    if let Some(node) = std::env::args().nth(1) {
        if node == "--listen" {
            println!("can{} {:#X?}", link.channel, link.listen().await?);
            return Ok(());
        }
        link.node = node.parse()?;
    }
    let mut device = link.open().await?;
    println!(
        "gs_usb can{} node {} · {}/{} bit/s · type {:08X} vendor {} product {:08X} revision {:08X}",
        link.channel,
        link.node,
        link.nominal,
        link.data,
        device.read(0x1000, 0).await? as u32,
        device.read(0x1018, 1).await?,
        device.read(0x1018, 2).await? as u32,
        device.read(0x1018, 3).await? as u32
    );
    println!("{:?}", device.feedback().await?);
    for slot in 1..=8 {
        println!("{:X?}", device.read_pdo(slot).await?);
    }
    Ok(())
}
