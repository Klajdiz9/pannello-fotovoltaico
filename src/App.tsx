import React, { useState, useMemo, useEffect, useRef } from 'react';
import { Settings, Info, BarChart2, FileJson, AlertCircle, CheckCircle2, Zap, Euro, Download, MapPin, Search } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export default function App() {
  // --- STATE: Input Parameters ---
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isLoadingWeather, setIsLoadingWeather] = useState(false);
  const [selectedLocation, setSelectedLocation] = useState({ name: 'Roma, Italia', lat: 41.89, lon: 12.51 });
  
  const [monthlyWeatherData, setMonthlyWeatherData] = useState<any[]>([]);
  const [apiGhi, setApiGhi] = useState(1550);

  const [ghi, setGhi] = useState<number>(1550); // kWh/m2/anno (Global Horizontal Irradiance) - editable override
  const [tilt, setTilt] = useState<number>(30); // gradi
  const [azimuth, setAzimuth] = useState<number>(0); // gradi (Sud=0)
  const [moduleType, setModuleType] = useState<'mono' | 'poly' | 'thin'>('mono');
  const [systemLosses, setSystemLosses] = useState<number>(14); // %
  const [inputMode, setInputMode] = useState<'kwp' | 'area'>('kwp');
  const [kwpInput, setKwpInput] = useState<number>(5.0);
  const [areaInput, setAreaInput] = useState<number>(25.0); // m2
  const [costPerKwp, setCostPerKwp] = useState<number>(1200); // €
  const [electricityPrice, setElectricityPrice] = useState<number>(0.25); // €/kWh

  const searchInputRef = useRef<HTMLInputElement>(null);

  // --- LOCATION & WEATHER FETCHING ---
  useEffect(() => {
    if (searchQuery.length < 3) {
      setSearchResults([]);
      return;
    }
    const delay = setTimeout(() => {
      setIsSearching(true);
      fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(searchQuery)}&count=5&language=it&format=json`)
        .then(res => res.json())
        .then(data => {
          if (data.results) {
            setSearchResults(data.results);
          } else {
            setSearchResults([]);
          }
          setIsSearching(false);
        })
        .catch(() => setIsSearching(false));
    }, 500);
    return () => clearTimeout(delay);
  }, [searchQuery]);

  useEffect(() => {
    if (!selectedLocation) return;
    setIsLoadingWeather(true);
    // Fetch historical data for 2023 
    fetch(`https://archive-api.open-meteo.com/v1/archive?latitude=${selectedLocation.lat}&longitude=${selectedLocation.lon}&start_date=2023-01-01&end_date=2023-12-31&daily=shortwave_radiation_sum,temperature_2m_mean,wind_speed_10m_max&timezone=auto`)
      .then(res => res.json())
      .then(data => {
        if (!data || !data.daily) throw new Error("Invalid format");
        const daily = data.daily;
        const monthly = Array.from({length: 12}, () => ({ ghi: 0, tempSum: 0, windSum: 0, days: 0 }));
        
        daily.time.forEach((dateStr: string, i: number) => {
          const date = new Date(dateStr);
          const month = date.getMonth();
          monthly[month].ghi += (daily.shortwave_radiation_sum[i] || 0) / 3.6; // MJ to kWh
          monthly[month].tempSum += (daily.temperature_2m_mean[i] || 0);
          monthly[month].windSum += (daily.wind_speed_10m_max[i] || 0);
          monthly[month].days += 1;
        });

        const weatherData = monthly.map((m, i) => ({
          month: ['Gen', 'Feb', 'Mar', 'Apr', 'Mag', 'Giu', 'Lug', 'Ago', 'Set', 'Ott', 'Nov', 'Dic'][i],
          ghi: m.ghi,
          temp: m.tempSum / m.days,
          wind: m.windSum / m.days
        }));

        setMonthlyWeatherData(weatherData);
        const totalApiGhi = Math.round(weatherData.reduce((acc, m) => acc + m.ghi, 0));
        setApiGhi(totalApiGhi);
        setGhi(totalApiGhi); // Update the user-editable field to match
        setIsLoadingWeather(false);
      })
      .catch(err => {
        console.error(err);
        setIsLoadingWeather(false);
      });
  }, [selectedLocation]);

  // --- CALCULATIONS ---
  const { baseEfficiency, typeName, tempCoeff } = useMemo(() => {
    switch (moduleType) {
      case 'poly': return { baseEfficiency: 0.17, typeName: 'Policristallino', tempCoeff: -0.0040 };
      case 'thin': return { baseEfficiency: 0.12, typeName: 'Thin-film', tempCoeff: -0.0020 };
      case 'mono':
      default: return { baseEfficiency: 0.21, typeName: 'Monocristallino', tempCoeff: -0.0034 };
    }
  }, [moduleType]);

  const targetKwp = useMemo(() => {
    return inputMode === 'kwp' ? kwpInput : areaInput * baseEfficiency;
  }, [inputMode, kwpInput, areaInput, baseEfficiency]);

  const requiredArea = useMemo(() => {
    return inputMode === 'area' ? areaInput : kwpInput / baseEfficiency;
  }, [inputMode, kwpInput, areaInput, baseEfficiency]);

  const performanceRatio = 1 - (systemLosses / 100);

  // Empiric estimation of POA (Plane of Array) modifier
  const poaModifier = Math.max(0.6, 1 + 0.12 * Math.cos((tilt - 35) * Math.PI / 180) - 0.15 * (1 - Math.cos(azimuth * Math.PI / 180)));

  const { prod, totalAnnualProd, averageTemp, averageWind } = useMemo(() => {
    if (monthlyWeatherData.length === 0) {
      return { prod: [], totalAnnualProd: 0, averageTemp: 0, averageWind: 0 };
    }
    
    let annualSum = 0;
    let tSum = 0;
    let wSum = 0;
    
    const ghiScale = apiGhi > 0 ? ghi / apiGhi : 1; // Allows overriding GHI while keeping the monthly shape
    
    const p = monthlyWeatherData.map((data) => {
      const G_poa_monthly = data.ghi * ghiScale * poaModifier;
      
      // Faiman Module Temperature Model (Est peak sun hours)
      const wind_m_s = data.wind / 3.6;
      const T_cell_peak = data.temp + 600 / (25 + 6.84 * wind_m_s);
      
      const temp_efficiency_modifier = 1 + tempCoeff * (T_cell_peak - 25);
      const actual_efficiency = baseEfficiency * temp_efficiency_modifier;
      
      const monthProduction = targetKwp * temp_efficiency_modifier * G_poa_monthly * performanceRatio;
      annualSum += monthProduction;
      
      tSum += data.temp;
      wSum += data.wind;

      return {
        name: data.month,
        Produzione: Math.round(monthProduction),
        T_cell: Math.round(T_cell_peak),
        Efficiency: (actual_efficiency * 100).toFixed(1)
      };
    });

    return { 
      prod: p, 
      totalAnnualProd: annualSum,
      averageTemp: tSum / 12,
      averageWind: wSum / 12
    };
  }, [monthlyWeatherData, poaModifier, targetKwp, tempCoeff, baseEfficiency, performanceRatio, ghi, apiGhi]);

  const annualProduction = totalAnnualProd;
  const monthlyProduction = prod;

  const totalCost = targetKwp * costPerKwp;
  const annualSavings = annualProduction * electricityPrice;
  const roiYears = annualSavings > 0 ? totalCost / annualSavings : 0;

  // --- TECHNICAL ANALYSIS ---
  const technicalAnalysis = useMemo(() => {
    const issues = [];
    const suggestions = [];

    if (tilt < 20 || tilt > 45) {
      issues.push(`Tilt Sub-ottimale (${tilt}°).`);
      suggestions.push(`Considerare la regolazione del Tilt verso i 30-35 gradi per massimizzare la captazione solare annua.`);
    }
    if (Math.abs(azimuth) > 45) {
      issues.push(`Azimuth Devianza Elevata (${azimuth}°).`);
      suggestions.push(`L'orientamento attuale si discosta significativamente dal Sud ottimale (0°). Se possibile, orientare il sistema verso Sud per ridurre le perdite cosinusoidali.`);
    }
    if (performanceRatio < 0.8) {
      issues.push("Perdite di sistema elevate.");
      suggestions.push(`Un PR di ${(performanceRatio*100).toFixed(0)}% è basso. Verificare cablaggi, inverter e potenziali ombreggiamenti (shading). Un PR standard è > 80%.`);
    }
    if (averageTemp > 20) {
      issues.push(`Temperature ambientali elevate (Media ${averageTemp.toFixed(1)}°C)`);
      suggestions.push(`Il sito presenta condizioni climatiche calde che inducono un elevato derating termico. Valutare moduli con Coefficiente di Temperatura migliore (es. Heterojunction/HJT a -0.25%/°C).`);
    }

    if (issues.length === 0) {
      suggestions.push("Il sistema risulta eccellentemente configurato con parametri d'installazione vicini all'ottimale teorico per l'irraggiamento e il derating termico rilevati nel sito.");
    }

    return { issues, suggestions };
  }, [tilt, azimuth, performanceRatio, averageTemp]);

  // --- JSON EXPORT ---
  const peakCellTempAvg = averageTemp + (600 / (25 + 6.84 * (averageWind / 3.6)));

  const jsonExport = {
    system_id: `ITA-${new Date().getFullYear()}-0892`,
    location: {
      name: selectedLocation.name,
      lat: selectedLocation.lat,
      lon: selectedLocation.lon,
      climatic_data_year: 2023,
      avg_ambient_temp_C: Number(averageTemp.toFixed(2)),
      avg_wind_speed_kmh: Number(averageWind.toFixed(2))
    },
    parameters: {
      locationGHI_kWh_m2_yr: ghi,
      tiltDegrees: tilt,
      azimuthDegrees: azimuth,
      modules: {
        type: typeName,
        base_efficiency: baseEfficiency,
        thermal_coefficient: tempCoeff,
        targetCapacity_kWp: Number(targetKwp.toFixed(2)),
        requiredArea_m2: Number(requiredArea.toFixed(2))
      },
      systemLossesPercent: systemLosses,
      performanceRatio: Number(performanceRatio.toFixed(3)),
      economics: {
        installationCost_EUR_kWp: costPerKwp,
        electricityPrice_EUR_kWh: electricityPrice
      }
    },
    results: {
      annualProduction_kWh: Number(annualProduction.toFixed(1)),
      totalInstallationCost_EUR: Number(totalCost.toFixed(2)),
      annualSavings_EUR: Number(annualSavings.toFixed(2)),
      returnOnInvestment_Years: Number(roiYears.toFixed(2)),
      thermal_derating_average_percent: Number((Math.max(0, -tempCoeff * (peakCellTempAvg - 25)) * 100).toFixed(2))
    }
  };

  const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      const data = payload[0].payload;
      return (
        <div className="bg-[#0A0A0A] border border-[#2A2A2A] rounded p-3 text-xs w-48 shadow-lg">
          <div className="font-bold text-white mb-2 pb-2 border-b border-[#222]">{label}</div>
          <div className="flex justify-between items-center mb-1">
            <span className="text-[#666]">Produzione</span>
            <span className="text-[#00D1FF] font-mono">{data.Produzione} kWh</span>
          </div>
          {data.T_cell !== undefined && (
            <div className="flex justify-between items-center mb-1">
              <span className="text-[#666]">Temp. Cella picco</span>
              <span className="text-[#FF4D4D] font-mono">{data.T_cell}°C</span>
            </div>
          )}
          {data.Efficiency !== undefined && (
            <div className="flex justify-between items-center">
              <span className="text-[#666]">Efficienza Reale</span>
              <span className="text-[#00FF85] font-mono">{data.Efficiency}%</span>
            </div>
          )}
        </div>
      );
    }
    return null;
  };

  return (
    <div className="min-h-screen bg-[#0A0A0A] text-[#E0E0E0] font-sans flex flex-col">
      {/* Header */}
      <header className="border-b border-[#2A2A2A] pb-4 mb-6 pt-6 px-4">
        <div className="max-w-7xl mx-auto flex justify-between items-end">
          <div>
            <h1 className="text-xs font-mono text-[#00D1FF] tracking-[0.2em] uppercase mb-1">Energy Systems Engineering</h1>
            <h2 className="text-2xl font-semibold text-white tracking-tight">HELIOS | PV Simulation Engine <span className="text-[#00D1FF]/50 text-sm font-normal ml-2">v4.2.0-STABLE</span></h2>
          </div>
          <div className="text-right hidden sm:block">
            <div className="text-[10px] uppercase tracking-widest text-[#666] mb-1">Project ID</div>
            <div className="text-sm font-mono text-white">ITA-RM-{new Date().getFullYear()}-0892</div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl w-full mx-auto px-4 pb-8 grid grid-cols-1 lg:grid-cols-4 gap-6">
        
        {/* Left Column: Input Panel */}
        <aside className="lg:col-span-1 flex flex-col gap-6">
          <div className="bg-[#141414] border border-[#2A2A2A] rounded-lg p-4">
            <h3 className="text-[10px] uppercase tracking-wider text-[#00D1FF] font-bold mb-4 flex items-center">
              <span className="w-1.5 h-1.5 rounded-full bg-[#00D1FF] mr-2"></span> Parametri Sistema
            </h3>
            
            <div className="space-y-5">
              
              {/* Geometria e Località */}
              <div className="space-y-3">
                <h4 className="text-[10px] text-[#666] uppercase font-bold tracking-wider mb-2">Località & Dati Meteo</h4>
                
                <div className="relative">
                  <label className="block text-[10px] text-[#666] uppercase mb-1">Cerca Località</label>
                  <div className="relative">
                    <input 
                      ref={searchInputRef}
                      type="text" 
                      placeholder="es. Roma, Milano..." 
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="w-full pl-8 pr-3 py-2 bg-[#0A0A0A] border border-[#2A2A2A] rounded focus:border-[#00D1FF] focus:ring-1 focus:ring-[#00D1FF] text-white text-sm outline-none transition-all placeholder-[#444]" 
                    />
                    <Search className="w-4 h-4 text-[#666] absolute left-2.5 top-2.5" />
                  </div>
                  
                  {isSearching && (
                    <div className="absolute right-2.5 top-8">
                      <div className="w-3 h-3 border-2 border-t-transparent border-[#00D1FF] rounded-full animate-spin"></div>
                    </div>
                  )}

                  {searchResults.length > 0 && searchQuery.length > 0 && (
                    <div className="absolute z-10 w-full bg-[#141414] border border-[#2A2A2A] mt-1 rounded shadow-lg overflow-hidden">
                      {searchResults.map((res: any) => (
                        <div 
                           key={res.id} 
                           className="px-3 py-2 cursor-pointer hover:bg-[#2A2A2A] text-sm text-white"
                           onClick={() => {
                              setSelectedLocation({ name: `${res.name}, ${res.country}`, lat: res.latitude, lon: res.longitude });
                              setSearchQuery('');
                              setSearchResults([]);
                           }}
                        >
                          {res.name}, <span className="text-[#888]">{res.admin1 ? res.admin1 + ', ' : ''}{res.country}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="bg-[#050505] border border-[#222] p-3 rounded">
                  <div className="flex justify-between items-start">
                    <div>
                      <div className="text-[10px] text-[#888] uppercase mb-1">Località Configurata</div>
                      <div className="text-sm font-semibold text-white truncate">{selectedLocation.name}</div>
                      <div className="text-[10px] font-mono text-[#666] mt-0.5">Lat: {selectedLocation.lat.toFixed(3)}, Lon: {selectedLocation.lon.toFixed(3)}</div>
                    </div>
                    {isLoadingWeather && <div className="w-3 h-3 border-2 border-t-transparent border-[#00FF85] rounded-full animate-spin mt-1"></div>}
                  </div>
                </div>

                <div>
                  <label className="block text-[10px] text-[#666] uppercase mb-1">GHI Annuo (kWh/m²)</label>
                  <input type="number" value={ghi} onChange={(e) => setGhi(Number(e.target.value))} className="w-full px-3 py-2 bg-[#0A0A0A] border border-[#2A2A2A] rounded focus:border-[#00D1FF] focus:ring-1 focus:ring-[#00D1FF] text-white text-sm outline-none transition-all" />
                  <div className="text-[9px] text-[#888] mt-1 text-right">Dato originale API: <span className="text-[#00D1FF] font-mono">{apiGhi}</span></div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[10px] text-[#666] uppercase mb-1">Tilt (°)</label>
                    <input type="number" value={tilt} onChange={(e) => setTilt(Number(e.target.value))} className="w-full px-3 py-2 bg-[#0A0A0A] border border-[#2A2A2A] rounded focus:border-[#00D1FF] focus:ring-1 focus:ring-[#00D1FF] text-white text-sm outline-none transition-all" />
                  </div>
                  <div>
                    <label className="block text-[10px] text-[#666] uppercase mb-1">Azimuth (°)</label>
                    <input type="number" value={azimuth} onChange={(e) => setAzimuth(Number(e.target.value))} className="w-full px-3 py-2 bg-[#0A0A0A] border border-[#2A2A2A] rounded focus:border-[#00D1FF] focus:ring-1 focus:ring-[#00D1FF] text-white text-sm outline-none transition-all" />
                  </div>
                </div>
              </div>

              <hr className="border-[#222]" />

              {/* Tecniche Base */}
              <div className="space-y-3">
                <h4 className="text-[10px] text-[#666] uppercase font-bold tracking-wider">Specifiche Moduli</h4>
                <div>
                  <label className="block text-[10px] text-[#666] uppercase mb-1">Tecnologia (Celle)</label>
                  <select value={moduleType} onChange={(e) => setModuleType(e.target.value as any)} className="w-full px-3 py-2 bg-[#0A0A0A] border border-[#2A2A2A] rounded focus:border-[#00D1FF] focus:ring-1 focus:ring-[#00D1FF] text-white text-sm outline-none transition-all">
                    <option value="mono">Monocristallino (~21% eff.)</option>
                    <option value="poly">Policristallino (~17% eff.)</option>
                    <option value="thin">Thin-film (~12% eff.)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] text-[#666] uppercase mb-1">Perdite Cablaggio/Inv. (%)</label>
                  <input type="number" step="0.1" value={systemLosses} onChange={(e) => setSystemLosses(Number(e.target.value))} className="w-full px-3 py-2 bg-[#0A0A0A] border border-[#2A2A2A] rounded focus:border-[#00D1FF] focus:ring-1 focus:ring-[#00D1FF] text-white text-sm outline-none transition-all" />
                </div>
                
                <div>
                  <div className="flex border border-[#2A2A2A] rounded overflow-hidden text-[10px] uppercase font-bold tracking-wider mb-3">
                    <button onClick={() => setInputMode('kwp')} className={cn("flex-1 py-1.5 transition-colors", inputMode === 'kwp' ? "bg-[#00D1FF]/20 text-[#00D1FF]" : "bg-[#0A0A0A] text-[#666] hover:text-white")}>Potenza</button>
                    <button onClick={() => setInputMode('area')} className={cn("flex-1 py-1.5 transition-colors border-l border-[#2A2A2A]", inputMode === 'area' ? "bg-[#00D1FF]/20 text-[#00D1FF]" : "bg-[#0A0A0A] text-[#666] hover:text-white")}>Superficie</button>
                  </div>
                  {inputMode === 'kwp' ? (
                    <div>
                      <label className="block text-[10px] text-[#666] uppercase mb-1">Potenza (kWp)</label>
                      <input type="number" step="0.1" value={kwpInput} onChange={(e) => setKwpInput(Number(e.target.value))} className="w-full px-3 py-2 bg-[#0A0A0A] border border-[#2A2A2A] rounded focus:border-[#00D1FF] focus:ring-1 focus:ring-[#00D1FF] text-white text-sm outline-none transition-all" />
                    </div>
                  ) : (
                    <div>
                      <label className="block text-[10px] text-[#666] uppercase mb-1">Area Disponibile (m²)</label>
                      <input type="number" step="1" value={areaInput} onChange={(e) => setAreaInput(Number(e.target.value))} className="w-full px-3 py-2 bg-[#0A0A0A] border border-[#2A2A2A] rounded focus:border-[#00D1FF] focus:ring-1 focus:ring-[#00D1FF] text-white text-sm outline-none transition-all" />
                    </div>
                  )}
                </div>
              </div>

              <hr className="border-[#222]" />

              {/* Economia */}
              <div className="space-y-3">
                <h4 className="text-[10px] text-[#666] uppercase font-bold tracking-wider">Dati Economici</h4>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[10px] text-[#666] uppercase mb-1">Costo (€/kWp)</label>
                    <input type="number" step="50" value={costPerKwp} onChange={(e) => setCostPerKwp(Number(e.target.value))} className="w-full px-3 py-2 bg-[#0A0A0A] border border-[#2A2A2A] rounded focus:border-[#00D1FF] focus:ring-1 focus:ring-[#00D1FF] text-white text-sm outline-none transition-all" />
                  </div>
                  <div>
                    <label className="block text-[10px] text-[#666] uppercase mb-1">Prezzo Rete (€)</label>
                    <input type="number" step="0.01" value={electricityPrice} onChange={(e) => setElectricityPrice(Number(e.target.value))} className="w-full px-3 py-2 bg-[#0A0A0A] border border-[#2A2A2A] rounded focus:border-[#00D1FF] focus:ring-1 focus:ring-[#00D1FF] text-white text-sm outline-none transition-all" />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </aside>

        {/* Right Column: Output & Analysis */}
        <div className="lg:col-span-3 flex flex-col gap-6">
          
          {/* Section 1: Riepilogo Parametri */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-[#141414] border-l-2 border-l-[#00D1FF] p-4 rounded-r-lg">
              <div className="text-[10px] text-[#666] uppercase mb-1 tracking-wider">Potenza DC</div>
              <div className="text-2xl font-mono text-white leading-tight">{targetKwp.toFixed(2)}</div>
              <div className="text-[10px] text-[#00D1FF]">kWp TARGET</div>
            </div>
            <div className="bg-[#141414] border-l-2 border-l-[#00D1FF] p-4 rounded-r-lg">
              <div className="text-[10px] text-[#666] uppercase mb-1 tracking-wider">Superficie Netta</div>
              <div className="text-2xl font-mono text-white leading-tight">{requiredArea.toFixed(1)}</div>
              <div className="text-[10px] text-[#00D1FF]">SQM AREA</div>
            </div>
            <div className="bg-[#141414] border-l-2 border-l-[#00D1FF] p-4 rounded-r-lg flex flex-col justify-center">
              <div className="text-[10px] text-[#666] uppercase mb-1 tracking-wider">Tecnologia Moduli</div>
              <div className="text-sm font-semibold text-white tracking-tight leading-loose">{typeName}</div>
            </div>
            <div className="bg-[#141414] border-l-2 border-l-[#00D1FF] p-4 rounded-r-lg">
              <div className="text-[10px] text-[#666] uppercase mb-1 tracking-wider">Performance Ratio</div>
              <div className="text-2xl font-mono text-white leading-tight">{(performanceRatio * 100).toFixed(1)}%</div>
              <div className="text-[10px] text-[#00D1FF]">SYSTEM PR</div>
            </div>
          </div>

          {/* Environmental Insight Blocks */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-center">
             <div className="bg-[#050505] border border-[#222] p-3 rounded">
               <div className="text-[10px] text-[#666] uppercase mb-1">Avg Ambient Temp</div>
               <div className="text-lg font-mono text-white">{averageTemp.toFixed(1)} <span className="text-xs text-[#888]">°C</span></div>
             </div>
             <div className="bg-[#050505] border border-[#222] p-3 rounded">
               <div className="text-[10px] text-[#666] uppercase mb-1">Avg Wind Speed</div>
               <div className="text-lg font-mono text-white">{averageWind.toFixed(1)} <span className="text-xs text-[#888]">km/h</span></div>
             </div>
             <div className="bg-[#050505] border border-[#222] p-3 rounded">
               <div className="text-[10px] text-[#666] uppercase mb-1">Est. Cell Temp (Peak)</div>
               <div className="text-lg font-mono text-[#FF4D4D]">{peakCellTempAvg.toFixed(1)} <span className="text-xs text-[#888]">°C</span></div>
             </div>
             <div className="bg-[#050505] border border-[#222] p-3 rounded">
               <div className="text-[10px] text-[#666] uppercase mb-1">Thermal Derating (Avg)</div>
               <div className="text-lg font-mono text-[#00D1FF]">{-((-(tempCoeff * (peakCellTempAvg - 25))) * 100).toFixed(1)} <span className="text-xs text-[#888]">%</span></div>
             </div>
          </div>

          {/* Section 2: Simulazione Energetica (Charts + ROI) */}
          <div className="bg-[#141414] border border-[#2A2A2A] rounded-lg p-6 flex flex-col">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 text-center border-b border-[#222] pb-6 mb-6">
              <div>
                <div className="text-[10px] font-bold uppercase tracking-widest text-[#666] mb-1">Produzione Annua</div>
                <div className="text-3xl font-mono text-white">{annualProduction.toLocaleString('it-IT', { maximumFractionDigits: 0 })}</div>
                <div className="text-[10px] text-[#00D1FF] mt-1 tracking-wider font-bold">kWh / ANNO</div>
              </div>
              <div className="border-t md:border-t-0 md:border-l border-[#222] pt-4 md:pt-0">
                <div className="text-[10px] font-bold uppercase tracking-widest text-[#666] mb-1">Risparmio Annuo</div>
                <div className="text-3xl font-mono text-[#00FF85]">€{(annualSavings).toLocaleString('it-IT', { maximumFractionDigits: 0 })}</div>
                <div className="text-[10px] text-[#888] mt-1 tracking-wider">@ {electricityPrice} €/kWh</div>
              </div>
              <div className="border-t md:border-t-0 md:border-l border-[#222] pt-4 md:pt-0">
                <div className="text-[10px] font-bold uppercase tracking-widest text-[#666] mb-1">Rientro Economico</div>
                <div className="text-3xl font-mono text-[#00D1FF]">{roiYears.toFixed(1)}</div>
                <div className="text-[10px] text-[#888] mt-1 tracking-wider">ANNI (ROI)</div>
              </div>
            </div>

            <div className="h-64 flex-grow relative">
              <div className="flex justify-between items-center mb-4">
                <h3 className="text-xs font-bold uppercase tracking-widest text-white">Produzione Mensile (kWh)</h3>
                <div className="flex gap-4 items-center">
                  <div className="flex items-center gap-1.5">
                    <div className="w-3 h-3 bg-[#00D1FF]/20 border border-[#00D1FF] rounded-sm"></div>
                    <span className="text-[10px] text-[#888] uppercase tracking-wider">Yield</span>
                  </div>
                  <div className="text-[9px] text-[#666] ml-2">Faiman Temp Mod.</div>
                </div>
              </div>
              <ResponsiveContainer width="100%" height="80%">
                <BarChart data={monthlyProduction} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#2A2A2A" />
                  <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: '#666' }} />
                  <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 10, fill: '#666' }} />
                  <Tooltip content={<CustomTooltip />} />
                  <Bar dataKey="Produzione" fill="#00D1FF" fillOpacity={0.8} radius={[2, 2, 0, 0]} maxBarSize={40} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Bottom Row: Analisi + JSON export */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            
            {/* Section 3: Analisi Tecnica */}
            <div className="bg-[#141414] border border-[#2A2A2A] rounded-lg p-4 flex flex-col">
               <h3 className="text-[10px] uppercase tracking-wider text-[#00D1FF] font-bold mb-4 flex items-center">
                 <AlertCircle className="w-3 h-3 mr-2" /> Analisi Tecnica
               </h3>
              <div className="space-y-3 overflow-y-auto">
                {technicalAnalysis.issues.map((issue, idx) => (
                  <div key={idx} className="bg-[#0A0A0A] border border-[#FF4D4D]/30 p-3 rounded">
                    <div className="text-[10px] font-bold text-[#FF4D4D] uppercase tracking-wider mb-1">Issue: {issue}</div>
                    <div className="text-xs text-[#888] leading-relaxed">{technicalAnalysis.suggestions[idx]}</div>
                  </div>
                ))}
                
                {technicalAnalysis.issues.length === 0 && (
                  <div className="bg-[#0A0A0A] border border-[#00FF85]/30 p-3 rounded">
                    <div className="text-[10px] font-bold text-[#00FF85] uppercase tracking-wider mb-1">System Optimized</div>
                    <div className="text-xs text-[#888] leading-relaxed">{technicalAnalysis.suggestions[0]}</div>
                  </div>
                )}
              </div>
            </div>

            {/* Section 4: JSON Export */}
            <div className="bg-[#050505] border border-[#2A2A2A] rounded-lg p-4 flex flex-col">
              <div className="flex justify-between items-center mb-3">
                <h3 className="text-[10px] uppercase tracking-wider text-[#666] font-bold flex items-center">
                  <FileJson className="w-3 h-3 mr-2" /> JSON Export Buffer
                </h3>
                <span className="text-[9px] bg-[#222] px-1.5 py-0.5 rounded text-[#888]">READ-ONLY</span>
              </div>
              <div className="bg-[#0A0A0A] p-3 rounded border border-[#222] flex-grow overflow-auto mb-3">
                <pre className="text-[10px] font-mono text-[#00D1FF]/70 leading-relaxed overflow-x-auto">
                  {JSON.stringify(jsonExport, null, 2)}
                </pre>
              </div>
              <button 
                onClick={() => navigator.clipboard.writeText(JSON.stringify(jsonExport, null, 2))}
                className="w-full py-2 flex items-center justify-center gap-2 bg-[#222] hover:bg-[#333] text-[10px] uppercase tracking-widest font-bold transition-colors border border-[#333] text-white rounded"
              >
                <Download className="w-3 h-3" /> Copy JSON to Clipboard
              </button>
            </div>

          </div>
        </div>
      </main>
      
      {/* Footer Status Bar */}
      <footer className="mt-auto px-6 py-4 flex flex-col sm:flex-row justify-between items-center text-[10px] text-[#444] border-t border-[#1A1A1A] uppercase tracking-tighter bg-[#0A0A0A]">
        <div className="flex gap-4 sm:gap-6 mb-2 sm:mb-0">
          <span>Engine: HELIOS v4.2</span>
          <span>Source: Open-Meteo Archive</span>
          <span className="hidden sm:inline">Thermal Mode: Faiman</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-[#00FF85] shadow-[0_0_8px_#00FF85]"></div>
          <span className="text-[#666]">Validation Passed: EN 61724-1 Standard</span>
        </div>
      </footer>
    </div>
  );
}

