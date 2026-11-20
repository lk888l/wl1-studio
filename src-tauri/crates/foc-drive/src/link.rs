use crate::od::{object, DATA, NOMINAL};
use anyhow::{bail, ensure, Context, Result};
use can_transport::{
    gs_usb::{GsTiming, GsUsbBus, GsUsbConfig, GsUsbDataRate},
    CanBus, CanFilter, CanFrame, CanId, CanRx, FrameKind,
};
use serde::{Deserialize, Serialize};
use std::{sync::Arc, time::Duration};
use tokio::time::timeout;

const IO_TIMEOUT: Duration = Duration::from_millis(300);

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub struct Link {
    pub channel: u16,
    pub node: u8,
    pub nominal: u32,
    pub data: u32,
}

impl Default for Link {
    fn default() -> Self {
        Self {
            channel: 0,
            node: 1,
            nominal: 1000000,
            data: 5000000,
        }
    }
}

impl Link {
    pub async fn open(self) -> Result<Node> {
        Node::attach(self.bus(false).await?, self.node).await
    }

    pub async fn listen(self) -> Result<Discovery> {
        let bus = self.bus(true).await?;
        let mut rx = bus.subscribe(CanFilter::pass_all_standard()).await?;
        let mut nodes = std::collections::BTreeMap::new();
        let mut ids = std::collections::BTreeSet::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        while let Ok(result) = tokio::time::timeout_at(deadline, rx.recv()).await {
            let frame = result?;
            let id = frame.id().raw() as u16;
            ids.insert(id);
            if (0x701..=0x77f).contains(&id)
                && frame.kind() == FrameKind::Data
                && matches!(frame.data(), [0 | 4 | 5 | 127])
            {
                nodes.insert((id - 0x700) as u8, frame.data()[0]);
            }
            if tokio::time::Instant::now() >= deadline {
                break;
            }
        }
        let health = bus.bus_state().await?;
        Ok(Discovery {
            nodes: nodes.into_iter().collect(),
            ids: ids.into_iter().collect(),
            health: health.map(|state| {
                format!(
                    "{:?} · TEC {:?} / REC {:?}",
                    state.state, state.tx_errors, state.rx_errors
                )
            }),
        })
    }

    pub(crate) fn timing_config(self, listen_only: bool) -> Result<GsUsbConfig> {
        ensure!(
            self.channel < 4 && (1..=127).contains(&self.node),
            "需要 can0–can3 和 Node-ID 1–127"
        );
        ensure!(
            NOMINAL.contains(&self.nominal) && DATA.contains(&self.data),
            "不支持的 CAN 位速率"
        );
        let rate = match self.data {
            1000000 => GsUsbDataRate::Mbps1,
            2000000 => GsUsbDataRate::Mbps2,
            4000000 => GsUsbDataRate::Mbps4,
            _ => GsUsbDataRate::Mbps5,
        };
        let mut config = GsUsbConfig::fd_1m(rate).with_channel(self.channel);
        config.listen_only = listen_only;
        config.nominal.brp = 1000000 / self.nominal;
        if self.data == 8000000 {
            config.data = Some(GsTiming {
                prop_seg: 3,
                phase_seg1: 4,
                phase_seg2: 2,
                sjw: 2,
                brp: 1,
            });
        }
        Ok(config)
    }

    async fn bus(self, listen_only: bool) -> Result<Arc<dyn CanBus>> {
        let bus = GsUsbBus::open_vid_pid(0x1209, 0x2323, self.timing_config(listen_only)?)
            .await
            .with_context(|| {
                format!(
                    "无法打开 gs_usb can{}（请检查 WinUSB、通道及占用）",
                    self.channel
                )
            })?;
        let actual = bus.link_config().await?.context("无法确认适配器位时序")?;
        ensure!(
            actual.fd_enabled == Some(true)
                && actual.nominal.and_then(|timing| timing.bitrate) == Some(self.nominal)
                && actual.data.and_then(|timing| timing.bitrate) == Some(self.data),
            "实际 CAN 时序与请求不一致；需要 80 MHz Hub"
        );
        Ok(Arc::new(bus))
    }
}

#[derive(Debug, Serialize)]
pub struct Discovery {
    pub nodes: Vec<(u8, u8)>,
    pub ids: Vec<u16>,
    pub health: Option<String>,
}

pub struct Node {
    pub(crate) bus: Arc<dyn CanBus>,
    pub(crate) id: u8,
    replies: Box<dyn CanRx>,
}

impl Node {
    pub async fn attach(bus: Arc<dyn CanBus>, id: u8) -> Result<Self> {
        ensure!(
            (1..=127).contains(&id) && bus.capabilities().fd,
            "节点或 CAN-FD 能力无效"
        );
        let replies = bus
            .subscribe(CanFilter::exact_standard(0x580 + u16::from(id)))
            .await?;
        let mut node = Self { bus, id, replies };
        node.identify().await?;
        Ok(node)
    }

    pub(crate) async fn identify(&mut self) -> Result<()> {
        let identity = (
            self.read(0x1000, 0).await? as u32,
            self.read(0x1018, 1).await? as u32,
            self.read(0x1018, 2).await? as u32,
        );
        ensure!(
            identity == (0x20192, 0, 0x431),
            "节点 {} 不是目标 G431 固件：{identity:X?}",
            self.id
        );
        Ok(())
    }

    pub(crate) async fn send(&self, frame: CanFrame) -> Result<()> {
        timeout(IO_TIMEOUT, self.bus.send(frame))
            .await
            .context("CAN 发送超时")??;
        Ok(())
    }

    pub(crate) async fn nmt(&self, opcode: u8) -> Result<()> {
        self.send(CanFrame::new_data(CanId::Standard(0), &[opcode, self.id])?)
            .await
    }

    async fn sdo(&mut self, index: u16, sub: u8, payload: Option<&[u8]>) -> Result<Vec<u8>> {
        let mut request = [0u8; 8];
        request[1..3].copy_from_slice(&index.to_le_bytes());
        request[3] = sub;
        request[0] = match payload {
            None => 0x40,
            Some(data) => {
                ensure!(matches!(data.len(), 1 | 2 | 4), "不支持的 SDO 长度");
                request[4..4 + data.len()].copy_from_slice(data);
                0x23 | ((4 - data.len()) << 2) as u8
            }
        };
        let address = format!("节点 {} SDO {index:04X}:{sub:02X}", self.id);
        let transaction = async {
            while self.replies.try_recv()?.is_some() {}
            self.send(CanFrame::new_data(
                CanId::Standard(0x600 + u16::from(self.id)),
                &request,
            )?)
            .await?;
            loop {
                let frame = self.replies.recv().await?;
                let data = frame.data();
                if frame.id() != CanId::Standard(0x580 + u16::from(self.id))
                    || frame.kind() != FrameKind::Data
                    || data.len() != 8
                    || data[1..4] != request[1..4]
                {
                    continue;
                }
                return match (data[0], payload) {
                    (0x80, _) => bail!(
                        "SDO abort 0x{:08X}",
                        u32::from_le_bytes(data[4..8].try_into()?)
                    ),
                    (0x60, Some(_)) => Ok(vec![]),
                    (command @ (0x4f | 0x4b | 0x43), None) => {
                        Ok(data[4..8 - ((command >> 2) & 3) as usize].to_vec())
                    }
                    _ => bail!("SDO 回复格式错误 0x{:02X}", data[0]),
                };
            }
        };
        timeout(IO_TIMEOUT, transaction)
            .await
            .with_context(|| format!("{address} 超时（检查节点、位速率与接线）"))?
            .context(address)
    }

    pub async fn read(&mut self, index: u16, sub: u8) -> Result<f64> {
        object(index, sub)?
            .scalar
            .decode(&self.sdo(index, sub, None).await?)
    }

    pub(crate) async fn write(&mut self, index: u16, sub: u8, value: f64) -> Result<()> {
        let bytes = object(index, sub)?.scalar.encode(value)?;
        self.sdo(index, sub, Some(&bytes)).await?;
        Ok(())
    }
}
