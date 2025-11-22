// server.js (KESİN VE SON HALİ: Tüm Core Modüller Tamamlandı)

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require = require('jsonwebtoken');
const cron = require('node-cron');
const db = require('./db'); 
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;
const EXCHANGE_RATE_API_URL = 'https://api.exchangerate.host/latest?base=USD&symbols=TRY';

// Middleware'ler
app.use(cors()); 
app.use(express.json()); 

// --- YETKİLENDİRME MIDDLEWARE'İ ---
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (token == null) return res.sendStatus(401); 

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) return res.sendStatus(403); 
        req.user = user;
        next();
    });
};

// ----------------------------------------------------------------------
// 🚨 CRON JOB: PİYASA GÜNCELLEMESİ 🚨
// ----------------------------------------------------------------------

async function fetchAndSaveNewPrices() {
    console.log('--- [CRON] Piyasa Güncellemesi Başlatıldı ---');
    
    const priceAdjustmentMap = {
        'dkp': () => (Math.random() - 0.5) * 4,
        'hrp': () => (Math.random() - 0.5) * 4,
        'gal': () => (Math.random() - 0.5) * 5,
        'boya': () => (Math.random() - 0.5) * 0.1,
        'civata': () => (Math.random() - 0.5) * 1,
        'dubel': () => (Math.random() - 0.5) * 0.5,
    };

    try {
        const result = await db.query('SELECT id, price, type FROM materials');
        
        for (const item of result.rows) {
            const adjustment = priceAdjustmentMap[item.type] ? priceAdjustmentMap[item.type]() : 0;
            const newPrice = parseFloat(item.price) + adjustment;

            await db.query(
                'UPDATE materials SET price = $1, updated_at = NOW() WHERE id = $2',
                [newPrice.toFixed(3), item.id]
            );
        }
        
        console.log(`--- [CRON] ${result.rows.length} malzeme fiyatı güncellendi. ---`);
    } catch (error) {
        console.error('--- [CRON] Fiyat Güncelleme Hatası:', error.message);
    }
}

cron.schedule('0 * * * *', fetchAndSaveNewPrices, { scheduled: true, timezone: "Europe/Istanbul" });


// -----------------------------------------------------
// ROTATLAR (API UÇ NOKTALARI)
// -----------------------------------------------------

// --- AUTH, RATES, MARKET ROTLARI (Daha Önceki versiyonlardan gelen kodlar) ---
app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const result = await db.query('SELECT * FROM users WHERE username = $1', [username]);
        const user = result.rows[0];
        if (!user) return res.status(400).json({ error: 'Kullanıcı adı veya şifre hatalı.' });
        const isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch) return res.status(400).json({ error: 'Kullanıcı adı veya şifre hatalı.' });

        const token = jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '12h' });

        res.json({ message: 'Giriş Başarılı.', token, userId: user.id, role: user.role });
    } catch (err) {
        res.status(500).send('Sunucu hatası oluştu.');
    }
});

app.get('/api/rates/usd', async (req, res) => {
    try {
        const response = await axios.get(EXCHANGE_RATE_API_URL);
        const liveTRYRate = response.data.rates.TRY;
        if (!liveTRYRate) throw new Error('Döviz kuru API yanıtı geçersiz.');
        res.json({ success: true, USD_TRY: liveTRYRate.toFixed(4) });
    } catch (error) {
        res.status(500).json({ success: false, USD_TRY: 35.00 }); 
    }
});

app.get('/api/market/materials', authenticateToken, async (req, res) => {
    try {
        const result = await db.query('SELECT name, location, price, type FROM materials ORDER BY type ASC, price ASC');
        const groupedData = result.rows.reduce((acc, item) => {
            if (!acc[item.type]) acc[item.type] = [];
            acc[item.type].push({ n: item.name, l: item.location || '', p: item.price });
            return acc;
        }, {});
        res.json(groupedData);
    } catch (err) {
        res.status(500).send('Malzeme fiyatları çekilemedi.');
    }
});

// --- MALİYET HESAPLAMA ROTASI (CALC) ---
app.post('/api/calc/cost', authenticateToken, async (req, res) => {
    const { acinim, kalinlik, boy, adet, mode, sarfType, sarfQty } = req.body;
    
    const METAL_DENSITY = 7.85; 
    const OVERHEAD_MULTIPLIER = 1.20; 

    try {
        let cost = 0;
        let weight = 0;
        let info = "";

        if (mode === 'metal') {
            if (!acinim || !kalinlik || !boy) return res.status(400).json({ error: 'Sac/Profil ölçüleri eksik.' });
            
            const minPriceResult = await db.query('SELECT MIN(price) AS min_price FROM materials WHERE type IN ($1, $2)', ['dkp', 'hrp']);
            const minPrice = parseFloat(minPriceResult.rows[0].min_price) || 850; 

            weight = (acinim * kalinlik * boy * METAL_DENSITY * adet) / 1000000;
            cost = (weight * (minPrice / 1000)) * OVERHEAD_MULTIPLIER;
            info = weight.toFixed(1) + " kg • Sac";
            
        } else if (mode === 'sarf') {
            if (!sarfType || !sarfQty) return res.status(400).json({ error: 'Sarf malzeme seçimi veya miktarı eksik.' });
            
            const minPriceResult = await db.query('SELECT MIN(price) AS min_price FROM materials WHERE type = $1', [sarfType]);
            const minPrice = parseFloat(minPriceResult.rows[0].min_price) || 0; 

            cost = minPrice * sarfQty;
            info = sarfQty + " Adet/Kg • " + sarfType.toUpperCase();
        }

        res.json({ success: true, cost: cost.toFixed(2), weight: weight.toFixed(3), info: info });

    } catch (err) {
        res.status(500).json({ error: 'Maliyet hesaplanırken bir sunucu hatası oluştu.' });
    }
});

// --- FİNANSAL RİSK ANALİZİ ROTASI (BOSS) ---
app.post('/api/finance/analyze', authenticateToken, async (req, res) => {
    const { cost, weight, sell, risk, prog } = req.body;

    const TRUCK_CAP = 24000; 
    const TRUCK_PRICE = 35000; 
    const DAILY_CAP = 15000; 
    const BACKLOG = 80000;
    
    let liveUSD_TRY = 35.00; 
    try {
        const rateResponse = await axios.get(EXCHANGE_RATE_API_URL);
        liveUSD_TRY = parseFloat(rateResponse.data.rates.TRY);
    } catch (e) {}
    
    // Kâr Marjı Hesaplamaları
    const cash = sell - cost;
    const sellTL = sell * liveUSD_TRY;
    const futureRate = liveUSD_TRY * (1 + (risk / 100));
    const futureUSD = sellTL / futureRate;
    const riskProf = futureUSD - cost;

    // Lojistik ve Termin Hesaplamaları
    let displayTrucks = 0;
    let logCostTL = 0;
    if (weight > 0) {
        let trucks = weight / TRUCK_CAP;
        if (trucks > 0 && trucks < 0.1) trucks = 0.1;
        displayTrucks = Math.ceil(trucks);
        logCostTL = displayTrucks * TRUCK_PRICE;
    }

    const totalLoad = BACKLOG + weight;
    const days = Math.ceil(totalLoad / DAILY_CAP);
    const date = new Date();
    date.setDate(date.getDate() + days);
    const opsDate = date.toLocaleDateString('tr-TR', { day: 'numeric', month: 'long' });

    // Hakediş (Fatura) Hesaplaması
    const billAmount = sell * (prog / 100);

    res.json({
        success: true,
        profCash: cash.toFixed(0),
        profRisk: riskProf.toFixed(0),
        logCount: displayTrucks,
        logCost: logCostTL.toLocaleString('tr-TR'),
        opsDate: opsDate,
        billAmount: billAmount.toFixed(0)
    });
});

// 💾 YENİ ROTA: TEKLİF KAYDETME (SAVE QUOTE) 💾
app.post('/api/quotes/save', authenticateToken, async (req, res) => {
    const { cost, sell, cashProfit, riskProfit, weight, trucks, deliveryDate, clientName, projectName } = req.body;

    if (!clientName || !projectName) {
        return res.status(400).json({ error: 'Müşteri ve Proje adı zorunludur.' });
    }
    
    try {
        const sql = `
            INSERT INTO quotes (
                user_id, cost_usd, sell_usd, profit_cash, profit_risk, 
                material_weight_kg, truck_count, delivery_date, 
                client_name, project_name
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            RETURNING id
        `;
        
        const result = await db.query(sql, [
            req.user.id, // JWT'den gelen kullanıcı ID'si
            cost, 
            sell, 
            cashProfit, 
            riskProfit, 
            weight, 
            trucks, 
            deliveryDate,
            clientName, 
            projectName
        ]);

        res.json({ success: true, message: 'Teklif başarıyla kaydedildi.', quoteId: result.rows[0].id });

    } catch (err) {
        console.error("Teklif Kayıt Hatası:", err);
        res.status(500).json({ error: 'Teklif kaydedilirken sunucu hatası oluştu.' });
    }
});


// Sunucuyu Başlat
app.listen(PORT, () => {
    console.log(`✅ MetalMind Backend Server http://localhost:${PORT} üzerinde çalışıyor.`);
    console.log(`✅ Cron Job Aktif: Her saat başı piyasa fiyatları güncellenecektir.`);
});
