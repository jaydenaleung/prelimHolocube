Holocube
===

A volumetric display from stacked transparent displays as a premise to a true free-floating voxel-array display.

<img height="400" alt="Photo0_Holocube" src="https://github.com/user-attachments/assets/dfeaeefd-a537-487b-973c-abe09fe62049" />

---

## Overview

Holocube is a volumetric (three dimensional) display that utilizes transparent OLED display modules placed on top of each other to create a 128 by 128 by 8 pixel array. The goal of this project is to make a plain, electrical engineering-focused "hologram solution" before attempting to build a more theoretical or physics-based model for three-dimensional displays. The device is primarily run through an Arduino/ESP32-style microcontroller.

**Total time spent: 100+ hrs**

## Why I Created This Project

As suggested above, I am working on a larger personal project to realize three-dimensional display technology (commonly referred to as "holograms"). This provides a simple, stripped-down, preliminary solution to a more complex physics-based approach. Aside from that, it provides an easier solution to popularizing practical three-dimensional technology. Moreover, I simply love sci-fi and holograms and believe in their highly applicable potential, leading me to embark on this project.

## How It Works & Implementation

This device utilizes eight "stacked" transparent OLED displays from the Surenoo dealer on Aliexpress. The transparent OLED displays are driven using 12V external power, 3.3V logic, and SPI communication with an ESP32. The IC within the display is the SH1107 IC. The ESP32 uses either the Adafruit_SH110X + Adafruit_GFX, U8g2_lib, or SPI Arduino IDE library to send the specific SPI commands to drive the OLED panels. The datasheet specifies an external application circuit that includes external capacitors and resistors. See the datasheet for more information. The case was built using the Onshape CAD software.

A log of my testing can be found in the Word document in this repository.

NOTE: The markings on the PCB adapter that come with the transparent OLED display are incorrect. Refer to the PCB for the correct pin markings, with the display output pads always facing up and away from the PCB.

## Rough Bill of Materials (BOM)

| **Name** | **Quantity** | **Price (per part)** | **Link** |
| --- | --- | --- | --- |
| Transparent OLED Display | 8   | $10.15125 | [aliexpress.us/item/3256807797385510.html](https://www.aliexpress.us/item/3256807797385510.html) |
| PCB from JLCPCB | 5 (minimum order qty) | $3.42 | [jlcpcb.com](jlcpcb.com) |
| 30-Pin ESP-32 (28.2 x 51.4 mm) | 1   | $5.11 | [https://www.aliexpress.us/item/3256806034074322.html](https://www.aliexpress.us/item/3256806034074322.html) |
| 12V Power Source/Battery | 1   | $4.87 | [https://www.aliexpress.us/item/3256806309380899.html](https://www.aliexpress.us/item/3256806309380899.html) |
| 1μF Ceramic Capacitor | 8   | $0.033333 | [https://www.amazon.com/BOJACK-Capacitor-Multilayer-Monolithic-Assortment/dp/B085RDTCCV/](https://www.amazon.com/BOJACK-Capacitor-Multilayer-Monolithic-Assortment/dp/B085RDTCCV/) |
| 4.7μF Electrolytic Capacitor | 16  | $0.041667 | [https://www.amazon.com/ALLECIN-Electrolytic-Capacitor-Assortment-Kit/dp/B0C1VBXCQM/](https://www.amazon.com/ALLECIN-Electrolytic-Capacitor-Assortment-Kit/dp/B0C1VBXCQM/) |
| 1MΩ Resistor | 8   | $0.01 | [https://www.amazon.com/BOJACK-Values-Resistor-Resistors-Assortment/dp/B08FD1XVL6/](https://www.amazon.com/BOJACK-Values-Resistor-Resistors-Assortment/dp/B08FD1XVL6/) |
