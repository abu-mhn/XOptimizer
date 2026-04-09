package com.example.demo;

import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

import org.apache.coyote.BadRequestException;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;

@RestController
public class BeybladeStatCalculator {

        private final ObjectMapper objectMapper = new ObjectMapper();

        @PostMapping("/bbsc")
        public Map<String, Object> statCalculator(@RequestBody Map<String, Object> request)
                        throws BadRequestException, JsonProcessingException {

                // Parse top
                Object topObj = request.get("top");
                if (topObj == null) {
                        throw new BadRequestException("Missing 'top' object in request.");
                }

                Map<String, Object> top;
                if (topObj instanceof String) {
                        top = objectMapper.readValue((String) topObj, new TypeReference<Map<String, Object>>() {
                        });
                } else if (topObj instanceof Map) {
                        @SuppressWarnings("unchecked")
                        Map<String, Object> safeTop = (Map<String, Object>) topObj;
                        top = safeTop;
                } else {
                        throw new BadRequestException("'top' is not a valid object");
                }

                String requestedBlade = (String) top.get("blade");
                if (requestedBlade == null || requestedBlade.isEmpty()) {
                        throw new BadRequestException("Missing 'blade' in 'top' object.");
                }

                // Parse bottom
                Object bottomObj = request.get("bottom");
                if (bottomObj == null) {
                        throw new BadRequestException("Missing 'bottom' object in request.");
                }

                Map<String, Object> bottom;
                if (bottomObj instanceof String) {
                        bottom = objectMapper.readValue((String) bottomObj, new TypeReference<Map<String, Object>>() {
                        });
                } else if (bottomObj instanceof Map) {
                        @SuppressWarnings("unchecked")
                        Map<String, Object> safeBottom = (Map<String, Object>) bottomObj;
                        bottom = safeBottom;
                } else {
                        throw new BadRequestException("'bottom' is not a valid object");
                }

                String requestedRatchet = (String) bottom.get("ratchet");
                String requestedBit = (String) bottom.get("bit");

                Object ratchetBitObj = bottom.get("ratchetBit");
                Map<String, Object> ratchetBitPayload;
                if (ratchetBitObj instanceof Map) {
                        @SuppressWarnings("unchecked")
                        Map<String, Object> safeMap = (Map<String, Object>) ratchetBitObj;
                        ratchetBitPayload = safeMap;
                } else {
                        ratchetBitPayload = objectMapper.readValue((String) ratchetBitObj,
                                        new TypeReference<Map<String, Object>>() {
                                        });
                }

                String requestedRatchetBitName = (String) ratchetBitPayload.get("name");
                String requestedRatchetBitMode = (String) ratchetBitPayload.get("mode");

                String requestedRatchetBit = requestedRatchetBitName +
                                (requestedRatchetBitMode == null || requestedRatchetBitMode.isEmpty()
                                                ? ""
                                                : "(" + requestedRatchetBitMode + ")");

                // --- Data lookups ---
                List<Map<String, Object>> filteredBladeData = getBladeData(requestedBlade);
                List<Map<String, Object>> filteredRatchetData = getRatchetData(requestedRatchet);
                List<Map<String, Object>> filteredBitData = getBitData(requestedBit);
                List<Map<String, Object>> filteredRatchetBitData = getRatchetBitData(requestedRatchetBit);

                // --- Build response ---
                LocalDateTime nowDateTime = LocalDateTime.now();
                Map<String, Object> mainResponse = new LinkedHashMap<>();
                Map<String, Object> data = new LinkedHashMap<>();
                String status;
                String message;

                Map<String, Object> bladeResult = filteredBladeData.stream().findFirst().orElse(null);
                Map<String, Object> ratchetResult = filteredRatchetData.stream().findFirst().orElse(null);
                Map<String, Object> bitResult = filteredBitData.stream().findFirst().orElse(null);
                Map<String, Object> ratchetBitResult = filteredRatchetBitData.stream().findFirst().orElse(null);

                boolean hasValidTop = bladeResult != null;

                // Special blade rules
                String bladeCode = bladeResult != null ? (String) bladeResult.get("codename") : null;
                boolean isBulletGriffon = "BULLETGRIFFON".equals(bladeCode);

                boolean hasValidBottom = (ratchetResult != null && bitResult != null)
                                || ratchetBitResult != null
                                || (isBulletGriffon && bitResult != null);

                // Clock Mirage special rules
                String ratchetCode = ratchetResult != null ? (String) ratchetResult.get("name") : null;
                boolean clockMirageMismatch = "CLOCKMIRAGE".equals(bladeCode)
                                && (ratchetCode == null || !ratchetCode.endsWith("5")) && ratchetBitResult == null;
                boolean clockMirageInvalidBit = "CLOCKMIRAGE".equals(bladeCode) && ratchetBitResult != null;

                if (!hasValidTop || !hasValidBottom || clockMirageMismatch || clockMirageInvalidBit) {
                        status = "Failure";
                        message = "Combo failed to create";
                } else {
                        status = "Success";
                        message = "Combo created successfully";

                        // Top section
                        Map<String, Object> topResponse = new LinkedHashMap<>();
                        topResponse.put("blade", bladeResult);

                        int bladeAtk = (int) bladeResult.get("atk");
                        int bladeDef = (int) bladeResult.get("def");
                        int bladeSta = (int) bladeResult.get("sta");
                        boolean topAtkHasZero = bladeAtk == 0;
                        boolean topDefHasZero = bladeDef == 0;
                        boolean topStaHasZero = bladeSta == 0;
                        topResponse.put("totalAtk", topAtkHasZero ? "TBA" : bladeAtk);
                        topResponse.put("totalDef", topDefHasZero ? "TBA" : bladeDef);
                        topResponse.put("totalSta", topStaHasZero ? "TBA" : bladeSta);

                        double bladeWeight = (double) bladeResult.get("weight");
                        boolean topWeightHasZero = bladeWeight == 0;
                        topResponse.put("totalWeight", topWeightHasZero ? "TBA"
                                        : String.format("%.2f", bladeWeight) + "g");

                        String spinDirection = (String) bladeResult.get("spindirection");
                        topResponse.put("spinDirection", spinDirection);

                        data.put("top", topResponse);

                        // Bottom section
                        Map<String, Object> bottomResponse = new LinkedHashMap<>();
                        double bottomWeight;
                        boolean bottomAtkHasZero;
                        boolean bottomDefHasZero;
                        boolean bottomStaHasZero;
                        boolean bottomWeightHasZero;
                        if (ratchetBitResult != null
                                        && requestedRatchetBitName != null && !requestedRatchetBitName.isEmpty()
                                        && !"CLOCKMIRAGE".equals(bladeCode)) {
                                bottomResponse.put("ratchetBit", ratchetBitResult);
                                int rbAtk = (int) ratchetBitResult.get("atk");
                                int rbDef = (int) ratchetBitResult.get("def");
                                int rbSta = (int) ratchetBitResult.get("sta");
                                bottomAtkHasZero = rbAtk == 0;
                                bottomDefHasZero = rbDef == 0;
                                bottomStaHasZero = rbSta == 0;
                                bottomResponse.put("totalAtk", bottomAtkHasZero ? "TBA" : rbAtk);
                                bottomResponse.put("totalDef", bottomDefHasZero ? "TBA" : rbDef);
                                bottomResponse.put("totalSta", bottomStaHasZero ? "TBA" : rbSta);
                                bottomResponse.put("height", (int) ratchetBitResult.get("height"));
                                bottomResponse.put("dash", (int) ratchetBitResult.get("dash"));
                                bottomResponse.put("burstRes", (int) ratchetBitResult.get("burstRes"));
                                bottomWeight = (double) ratchetBitResult.get("weight");
                                bottomWeightHasZero = bottomWeight == 0;
                                bottomResponse.put("totalWeight", bottomWeightHasZero ? "TBA"
                                                : String.format("%.2f", bottomWeight) + "g");
                        } else {
                                if (ratchetResult != null) {
                                        bottomResponse.put("ratchet", ratchetResult);
                                }
                                bottomResponse.put("bit", bitResult);
                                int rAtk = ratchetResult != null ? (int) ratchetResult.get("atk") : 0;
                                int rDef = ratchetResult != null ? (int) ratchetResult.get("def") : 0;
                                int rSta = ratchetResult != null ? (int) ratchetResult.get("sta") : 0;
                                int bAtk = (int) bitResult.get("atk");
                                int bDef = (int) bitResult.get("def");
                                int bSta = (int) bitResult.get("sta");
                                int bottomAtk = isBulletGriffon ? bAtk : rAtk + bAtk;
                                int bottomDef = isBulletGriffon ? bDef : rDef + bDef;
                                int bottomSta = isBulletGriffon ? bSta : rSta + bSta;
                                bottomAtkHasZero = isBulletGriffon ? bAtk == 0 : rAtk == 0 || bAtk == 0;
                                bottomDefHasZero = isBulletGriffon ? bDef == 0 : rDef == 0 || bDef == 0;
                                bottomStaHasZero = isBulletGriffon ? bSta == 0 : rSta == 0 || bSta == 0;
                                bottomResponse.put("totalAtk", bottomAtkHasZero ? "TBA" : bottomAtk);
                                bottomResponse.put("totalDef", bottomDefHasZero ? "TBA" : bottomDef);
                                bottomResponse.put("totalSta", bottomStaHasZero ? "TBA" : bottomSta);
                                if (ratchetResult != null) {
                                        bottomResponse.put("height", (int) ratchetResult.get("height"));
                                }
                                bottomResponse.put("dash", (int) bitResult.get("dash"));
                                bottomResponse.put("burstRes", (int) bitResult.get("burstRes"));
                                double rWeight = ratchetResult != null ? (double) ratchetResult.get("weight") : 0;
                                double bWeight = (double) bitResult.get("weight");
                                bottomWeight = isBulletGriffon ? bWeight : rWeight + bWeight;
                                bottomWeightHasZero = isBulletGriffon ? bWeight == 0 : rWeight == 0 || bWeight == 0;
                                bottomResponse.put("totalWeight", bottomWeightHasZero ? "TBA"
                                                : String.format("%.2f", bottomWeight) + "g");
                        }
                        data.put("bottom", bottomResponse);

                        // Grand totals
                        boolean grandAtkHasZero = topAtkHasZero || bottomAtkHasZero;
                        boolean grandDefHasZero = topDefHasZero || bottomDefHasZero;
                        boolean grandStaHasZero = topStaHasZero || bottomStaHasZero;
                        boolean grandWeightHasZero = topWeightHasZero || bottomWeightHasZero;
                        int grandAtk = bladeAtk + (bottomAtkHasZero ? 0 : (int) bottomResponse.get("totalAtk"));
                        int grandDef = bladeDef + (bottomDefHasZero ? 0 : (int) bottomResponse.get("totalDef"));
                        int grandSta = bladeSta + (bottomStaHasZero ? 0 : (int) bottomResponse.get("totalSta"));
                        double grandWeight = bladeWeight + bottomWeight;

                        Map<String, Object> totals = new LinkedHashMap<>();
                        totals.put("totalAtk", grandAtkHasZero ? "TBA" : grandAtk);
                        totals.put("totalDef", grandDefHasZero ? "TBA" : grandDef);
                        totals.put("totalSta", grandStaHasZero ? "TBA" : grandSta);
                        totals.put("totalWeight", grandWeightHasZero ? "TBA"
                                        : String.format("%.2f", grandWeight) + "g");
                        totals.put("ratchetBitMode", requestedRatchetBitMode);
                        totals.put("type", getType(grandAtk, grandDef, grandSta,
                                        ratchetBitResult != null && requestedRatchetBitName != null
                                                        && !requestedRatchetBitName.isEmpty()));
                        totals.put("spinDirection", spinDirection);
                        data.put("grandTotal", totals);

                        // Build combo name
                        StringBuilder comboName = new StringBuilder();
                        comboName.append(bladeCode);
                        if (ratchetBitResult != null
                                        && requestedRatchetBitName != null && !requestedRatchetBitName.isEmpty()
                                        && !"CLOCKMIRAGE".equals(bladeCode)) {
                                comboName.append((String) ratchetBitResult.get("codename"));
                        } else {
                                if (ratchetResult != null) {
                                        comboName.append((String) ratchetResult.get("name"));
                                }
                                comboName.append((String) bitResult.get("codename"));
                        }
                        data.put("name", comboName.toString());
                }

                mainResponse.put("status", status);
                mainResponse.put("message", message);
                mainResponse.put("data", data);
                mainResponse.put("createdDateTime", nowDateTime);

                return mainResponse;
        }

        @PostMapping("/bbsc/cx")
        public Map<String, Object> statCalculatorCX(@RequestBody Map<String, Object> request)
                        throws BadRequestException, JsonProcessingException {

                // Parse top
                Object topObj = request.get("top");
                if (topObj == null) {
                        throw new BadRequestException("Missing 'top' object in request.");
                }

                Map<String, Object> top;
                if (topObj instanceof String) {
                        top = objectMapper.readValue((String) topObj, new TypeReference<Map<String, Object>>() {
                        });
                } else if (topObj instanceof Map) {
                        @SuppressWarnings("unchecked")
                        Map<String, Object> safeTop = (Map<String, Object>) topObj;
                        top = safeTop;
                } else {
                        throw new BadRequestException("'top' is not a valid object");
                }

                // Parse lockChip
                String requestedLockChip = (String) top.get("lockChip");

                // Parse mainBlade
                Object mainBladeObj = top.get("mainBlade");
                if (mainBladeObj == null) {
                        throw new BadRequestException("Missing 'mainBlade' object in 'top'.");
                }
                Map<String, Object> mainBladeMap;
                if (mainBladeObj instanceof String) {
                        mainBladeMap = objectMapper.readValue((String) mainBladeObj,
                                        new TypeReference<Map<String, Object>>() {
                                        });
                } else if (mainBladeObj instanceof Map) {
                        @SuppressWarnings("unchecked")
                        Map<String, Object> safeMainBlade = (Map<String, Object>) mainBladeObj;
                        mainBladeMap = safeMainBlade;
                } else {
                        throw new BadRequestException("'mainBlade' is not a valid object");
                }

                // Parse assistBlade
                Object assistBladeObj = top.get("assistBlade");
                if (assistBladeObj == null) {
                        throw new BadRequestException("Missing 'assistBlade' object in 'top'.");
                }
                Map<String, Object> assistBladeMap;
                if (assistBladeObj instanceof String) {
                        assistBladeMap = objectMapper.readValue((String) assistBladeObj,
                                        new TypeReference<Map<String, Object>>() {
                                        });
                } else if (assistBladeObj instanceof Map) {
                        @SuppressWarnings("unchecked")
                        Map<String, Object> safeAssistBlade = (Map<String, Object>) assistBladeObj;
                        assistBladeMap = safeAssistBlade;
                } else {
                        throw new BadRequestException("'assistBlade' is not a valid object");
                }

                String requestedMainBlade = (String) mainBladeMap.get("name");
                String requestedMainBladeMode = (String) mainBladeMap.get("mode");
                String requestedAssistBlade = (String) assistBladeMap.get("name");
                String requestedAssistBladeMode = (String) assistBladeMap.get("mode");

                // Parse bottom
                @SuppressWarnings("unchecked")
                Map<String, Object> bottom = (Map<String, Object>) request.get("bottom");
                if (bottom == null) {
                        throw new BadRequestException("Missing 'bottom' object in request.");
                }
                String requestedRatchet = (String) bottom.get("ratchet");
                String requestedBit = (String) bottom.get("bit");

                Object ratchetBitObj = bottom.get("ratchetBit");
                Map<String, Object> ratchetBitPayload;
                if (ratchetBitObj instanceof Map) {
                        @SuppressWarnings("unchecked")
                        Map<String, Object> safeMap = (Map<String, Object>) ratchetBitObj;
                        ratchetBitPayload = safeMap;
                } else {
                        ratchetBitPayload = objectMapper.readValue((String) ratchetBitObj,
                                        new TypeReference<Map<String, Object>>() {
                                        });
                }

                String requestedRatchetBitName = (String) ratchetBitPayload.get("name");
                String requestedRatchetBitMode = (String) ratchetBitPayload.get("mode");

                String requestedRatchetBit = requestedRatchetBitName +
                                (requestedRatchetBitMode == null || requestedRatchetBitMode.isEmpty()
                                                ? ""
                                                : "(" + requestedRatchetBitMode + ")");

                // --- Data lookups ---
                List<Map<String, Object>> filteredLockChipData = getLockChipData(requestedLockChip);
                List<Map<String, Object>> filteredMainBladeData = getMainBladeData(requestedMainBlade,
                                requestedMainBladeMode);
                List<Map<String, Object>> filteredAssistBladeData = getAssistBladeData(requestedAssistBlade,
                                requestedAssistBladeMode);
                List<Map<String, Object>> filteredRatchetData = getRatchetData(requestedRatchet);
                List<Map<String, Object>> filteredBitData = getBitData(requestedBit);
                List<Map<String, Object>> filteredRatchetBitData = getRatchetBitData(requestedRatchetBit);

                // --- Build response ---
                LocalDateTime nowDateTime = LocalDateTime.now();
                Map<String, Object> mainResponse = new LinkedHashMap<>();
                Map<String, Object> data = new LinkedHashMap<>();
                String status;
                String message;

                Map<String, Object> lockChipResult = filteredLockChipData.stream().findFirst().orElse(null);
                Map<String, Object> mainBladeResult = filteredMainBladeData.stream().findFirst().orElse(null);
                Map<String, Object> assistBladeResult = filteredAssistBladeData.stream().findFirst().orElse(null);
                Map<String, Object> ratchetResult = filteredRatchetData.stream().findFirst().orElse(null);
                Map<String, Object> bitResult = filteredBitData.stream().findFirst().orElse(null);
                Map<String, Object> ratchetBitResult = filteredRatchetBitData.stream().findFirst().orElse(null);

                boolean hasValidTop = lockChipResult != null && mainBladeResult != null && assistBladeResult != null;
                boolean hasValidBottom = (ratchetResult != null && bitResult != null)
                                || ratchetBitResult != null;

                if (!hasValidTop || !hasValidBottom) {
                        status = "Failure";
                        message = "One or more components not found";
                } else {
                        status = "Success";
                        message = "Combo created successfully";

                        // Top section
                        Map<String, Object> topResponse = new LinkedHashMap<>();
                        topResponse.put("lockChip", lockChipResult);
                        topResponse.put("mainBlade", mainBladeResult);
                        topResponse.put("assistBlade", assistBladeResult);

                        int mbAtk = (int) mainBladeResult.get("atk");
                        int mbDef = (int) mainBladeResult.get("def");
                        int mbSta = (int) mainBladeResult.get("sta");
                        int abAtk = (int) assistBladeResult.get("atk");
                        int abDef = (int) assistBladeResult.get("def");
                        int abSta = (int) assistBladeResult.get("sta");
                        int topAtk = mbAtk + abAtk;
                        int topDef = mbDef + abDef;
                        int topSta = mbSta + abSta;
                        boolean topAtkHasZero = mbAtk == 0 || abAtk == 0;
                        boolean topDefHasZero = mbDef == 0 || abDef == 0;
                        boolean topStaHasZero = mbSta == 0 || abSta == 0;
                        topResponse.put("totalAtk", topAtkHasZero ? "TBA" : topAtk);
                        topResponse.put("totalDef", topDefHasZero ? "TBA" : topDef);
                        topResponse.put("totalSta", topStaHasZero ? "TBA" : topSta);

                        double lcWeight = (double) lockChipResult.get("weight");
                        double mbWeight = (double) mainBladeResult.get("weight");
                        double abWeight = (double) assistBladeResult.get("weight");
                        double topWeight = lcWeight + mbWeight + abWeight;
                        boolean topWeightHasZero = lcWeight == 0 || mbWeight == 0 || abWeight == 0;
                        topResponse.put("totalWeight", topWeightHasZero ? "TBA"
                                        : String.format("%.2f", topWeight) + "g");

                        String spinDirection = (String) mainBladeResult.get("spindirection");
                        topResponse.put("spinDirection", spinDirection);

                        data.put("top", topResponse);

                        // Bottom section
                        Map<String, Object> bottomResponse = new LinkedHashMap<>();
                        double bottomWeight;
                        boolean bottomAtkHasZero;
                        boolean bottomDefHasZero;
                        boolean bottomStaHasZero;
                        boolean bottomWeightHasZero;
                        if (ratchetBitResult != null
                                        && requestedRatchetBitName != null && !requestedRatchetBitName.isEmpty()) {
                                bottomResponse.put("ratchetBit", ratchetBitResult);
                                int rbAtk = (int) ratchetBitResult.get("atk");
                                int rbDef = (int) ratchetBitResult.get("def");
                                int rbSta = (int) ratchetBitResult.get("sta");
                                bottomAtkHasZero = rbAtk == 0;
                                bottomDefHasZero = rbDef == 0;
                                bottomStaHasZero = rbSta == 0;
                                bottomResponse.put("totalAtk", bottomAtkHasZero ? "TBA" : rbAtk);
                                bottomResponse.put("totalDef", bottomDefHasZero ? "TBA" : rbDef);
                                bottomResponse.put("totalSta", bottomStaHasZero ? "TBA" : rbSta);
                                bottomResponse.put("height", (int) ratchetBitResult.get("height"));
                                bottomResponse.put("dash", (int) ratchetBitResult.get("dash"));
                                bottomResponse.put("burstRes", (int) ratchetBitResult.get("burstRes"));
                                bottomWeight = (double) ratchetBitResult.get("weight");
                                bottomWeightHasZero = bottomWeight == 0;
                                bottomResponse.put("totalWeight", bottomWeightHasZero ? "TBA"
                                                : String.format("%.2f", bottomWeight) + "g");
                        } else {
                                bottomResponse.put("ratchet", ratchetResult);
                                bottomResponse.put("bit", bitResult);
                                int rAtk = (int) ratchetResult.get("atk");
                                int rDef = (int) ratchetResult.get("def");
                                int rSta = (int) ratchetResult.get("sta");
                                int bAtk = (int) bitResult.get("atk");
                                int bDef = (int) bitResult.get("def");
                                int bSta = (int) bitResult.get("sta");
                                int bottomAtk = rAtk + bAtk;
                                int bottomDef = rDef + bDef;
                                int bottomSta = rSta + bSta;
                                bottomAtkHasZero = rAtk == 0 || bAtk == 0;
                                bottomDefHasZero = rDef == 0 || bDef == 0;
                                bottomStaHasZero = rSta == 0 || bSta == 0;
                                bottomResponse.put("totalAtk", bottomAtkHasZero ? "TBA" : bottomAtk);
                                bottomResponse.put("totalDef", bottomDefHasZero ? "TBA" : bottomDef);
                                bottomResponse.put("totalSta", bottomStaHasZero ? "TBA" : bottomSta);
                                bottomResponse.put("height", (int) ratchetResult.get("height"));
                                bottomResponse.put("dash", (int) bitResult.get("dash"));
                                bottomResponse.put("burstRes", (int) bitResult.get("burstRes"));
                                double rWeight = (double) ratchetResult.get("weight");
                                double bWeight = (double) bitResult.get("weight");
                                bottomWeight = rWeight + bWeight;
                                bottomWeightHasZero = rWeight == 0 || bWeight == 0;
                                bottomResponse.put("totalWeight", bottomWeightHasZero ? "TBA"
                                                : String.format("%.2f", bottomWeight) + "g");
                        }
                        data.put("bottom", bottomResponse);

                        // Grand totals
                        boolean grandAtkHasZero = topAtkHasZero || bottomAtkHasZero;
                        boolean grandDefHasZero = topDefHasZero || bottomDefHasZero;
                        boolean grandStaHasZero = topStaHasZero || bottomStaHasZero;
                        boolean grandWeightHasZero = topWeightHasZero || bottomWeightHasZero;
                        int grandAtk = topAtk + (bottomAtkHasZero ? 0 : (int) bottomResponse.get("totalAtk"));
                        int grandDef = topDef + (bottomDefHasZero ? 0 : (int) bottomResponse.get("totalDef"));
                        int grandSta = topSta + (bottomStaHasZero ? 0 : (int) bottomResponse.get("totalSta"));
                        double grandWeight = topWeight + bottomWeight;

                        Map<String, Object> totals = new LinkedHashMap<>();
                        totals.put("totalAtk", grandAtkHasZero ? "TBA" : grandAtk);
                        totals.put("totalDef", grandDefHasZero ? "TBA" : grandDef);
                        totals.put("totalSta", grandStaHasZero ? "TBA" : grandSta);
                        totals.put("totalWeight", grandWeightHasZero ? "TBA"
                                        : String.format("%.2f", grandWeight) + "g");
                        totals.put("ratchetBitMode", requestedRatchetBitMode);
                        totals.put("type", getType(grandAtk, grandDef, grandSta,
                                        ratchetBitResult != null && requestedRatchetBitName != null
                                                        && !requestedRatchetBitName.isEmpty()));
                        totals.put("spinDirection", spinDirection);
                        data.put("grandTotal", totals);

                        // Build combo name
                        StringBuilder comboName = new StringBuilder();
                        comboName.append((String) lockChipResult.get("codename"));
                        comboName.append((String) mainBladeResult.get("codename"));
                        comboName.append((String) assistBladeResult.get("codename"));
                        if (ratchetBitResult != null
                                        && requestedRatchetBitName != null && !requestedRatchetBitName.isEmpty()) {
                                comboName.append((String) ratchetBitResult.get("codename"));
                        } else {
                                comboName.append((String) ratchetResult.get("name"));
                                comboName.append((String) bitResult.get("codename"));
                        }
                        data.put("name", comboName.toString());
                }

                mainResponse.put("status", status);
                mainResponse.put("message", message);
                mainResponse.put("data", data);
                mainResponse.put("createdDateTime", nowDateTime);

                return mainResponse;
        }

        @PostMapping("/bbsc/cx/expand")
        public Map<String, Object> statCalculatorCXExpand(@RequestBody Map<String, Object> request)
                        throws BadRequestException, JsonProcessingException {

                // Parse top
                Object topObj = request.get("top");
                if (topObj == null) {
                        throw new BadRequestException("Missing 'top' object in request.");
                }

                Map<String, Object> top;
                if (topObj instanceof String) {
                        top = objectMapper.readValue((String) topObj, new TypeReference<Map<String, Object>>() {
                        });
                } else if (topObj instanceof Map) {
                        @SuppressWarnings("unchecked")
                        Map<String, Object> safeTop = (Map<String, Object>) topObj;
                        top = safeTop;
                } else {
                        throw new BadRequestException("'top' is not a valid object");
                }

                // Parse lockChip
                String requestedLockChip = (String) top.get("lockChip");

                // Parse metalBlade
                Object metalBladeSpecObj = top.get("metalBlade");
                if (metalBladeSpecObj == null) {
                        throw new BadRequestException("Missing 'metalBlade' object in 'top'.");
                }
                Map<String, Object> metalBladeSpecMap;
                if (metalBladeSpecObj instanceof String) {
                        metalBladeSpecMap = objectMapper.readValue((String) metalBladeSpecObj,
                                        new TypeReference<Map<String, Object>>() {
                                        });
                } else if (metalBladeSpecObj instanceof Map) {
                        @SuppressWarnings("unchecked")
                        Map<String, Object> safeMetalBladeSpec = (Map<String, Object>) metalBladeSpecObj;
                        metalBladeSpecMap = safeMetalBladeSpec;
                } else {
                        throw new BadRequestException("'metalBlade' is not a valid object");
                }

                // Parse overBlade
                Object overBladeObj = top.get("overBlade");
                Map<String, Object> overBladeMap;
                if (overBladeObj instanceof String) {
                        overBladeMap = objectMapper.readValue((String) overBladeObj,
                                        new TypeReference<Map<String, Object>>() {
                                        });
                } else if (overBladeObj instanceof Map) {
                        @SuppressWarnings("unchecked")
                        Map<String, Object> safeOverBlade = (Map<String, Object>) overBladeObj;
                        overBladeMap = safeOverBlade;
                } else {
                        throw new BadRequestException("'overBlade' is not a valid object");
                }

                // Parse assistBlade
                Object assistBladeObj = top.get("assistBlade");
                Map<String, Object> assistBladeMap;
                if (assistBladeObj instanceof String) {
                        assistBladeMap = objectMapper.readValue((String) assistBladeObj,
                                        new TypeReference<Map<String, Object>>() {
                                        });
                } else if (assistBladeObj instanceof Map) {
                        @SuppressWarnings("unchecked")
                        Map<String, Object> safeAssistBlade = (Map<String, Object>) assistBladeObj;
                        assistBladeMap = safeAssistBlade;
                } else {
                        throw new BadRequestException("'assistBlade' is not a valid object");
                }

                String requestedMetalBlade = (String) metalBladeSpecMap.get("name");
                String requestedMetalBladeMode = (String) metalBladeSpecMap.get("mode");
                String requestedOverBlade = (String) overBladeMap.get("name");
                String requestedOverBladeMode = (String) overBladeMap.get("mode");
                String requestedAssistBlade = (String) assistBladeMap.get("name");
                String requestedAssistBladeMode = (String) assistBladeMap.get("mode");

                // Parse bottom
                @SuppressWarnings("unchecked")
                Map<String, Object> bottom = (Map<String, Object>) request.get("bottom");
                if (bottom == null) {
                        throw new BadRequestException("Missing 'bottom' object in request.");
                }
                String requestedRatchet = (String) bottom.get("ratchet");
                String requestedBit = (String) bottom.get("bit");

                Object ratchetBitObj = bottom.get("ratchetBit");
                Map<String, Object> ratchetBitPayload;
                if (ratchetBitObj instanceof Map) {
                        @SuppressWarnings("unchecked")
                        Map<String, Object> safeMap = (Map<String, Object>) ratchetBitObj;
                        ratchetBitPayload = safeMap;
                } else {
                        ratchetBitPayload = objectMapper.readValue((String) ratchetBitObj,
                                        new TypeReference<Map<String, Object>>() {
                                        });
                }

                String requestedRatchetBitName = (String) ratchetBitPayload.get("name");
                String requestedRatchetBitMode = (String) ratchetBitPayload.get("mode");

                String requestedRatchetBit = requestedRatchetBitName +
                                (requestedRatchetBitMode == null || requestedRatchetBitMode.isEmpty()
                                                ? ""
                                                : "(" + requestedRatchetBitMode + ")");

                // --- Data lookups ---

                // Lock chip data
                List<Map<String, Object>> filteredLockChipData = getLockChipData(requestedLockChip);

                // Metal blade data
                List<Map<String, Object>> filteredMetalBladeData = getMetalBladeData(requestedMetalBlade,
                                requestedMetalBladeMode);

                // Over blade data
                List<Map<String, Object>> filteredOverBladeData = getOverBladeData(requestedOverBlade,
                                requestedOverBladeMode);

                // Assist blade data
                List<Map<String, Object>> filteredAssistBladeData = getAssistBladeData(requestedAssistBlade,
                                requestedAssistBladeMode);

                // Ratchet data
                List<Map<String, Object>> filteredRatchetData = getRatchetData(requestedRatchet);

                // Bit data
                List<Map<String, Object>> filteredBitData = getBitData(requestedBit);

                // Ratchet-bit data
                List<Map<String, Object>> filteredRatchetBitData = getRatchetBitData(requestedRatchetBit);

                // --- Build expanded response ---
                LocalDateTime nowDateTime = LocalDateTime.now();
                Map<String, Object> mainResponse = new LinkedHashMap<>();
                Map<String, Object> data = new LinkedHashMap<>();
                String status;
                String message;

                // Lock chip details
                Map<String, Object> lockChipResult = filteredLockChipData.stream().findFirst().orElse(null);

                // Metal blade details
                Map<String, Object> metalBladeResult = filteredMetalBladeData.stream().findFirst().orElse(null);

                // Over blade details
                Map<String, Object> overBladeResult = filteredOverBladeData.stream().findFirst().orElse(null);

                // Assist blade details
                Map<String, Object> assistBladeResult = filteredAssistBladeData.stream().findFirst().orElse(null);

                // Ratchet details
                Map<String, Object> ratchetResult = filteredRatchetData.stream().findFirst().orElse(null);

                // Bit details
                Map<String, Object> bitResult = filteredBitData.stream().findFirst().orElse(null);

                // Ratchet-bit details
                Map<String, Object> ratchetBitResult = filteredRatchetBitData.stream().findFirst().orElse(null);

                boolean hasValidTop = lockChipResult != null && metalBladeResult != null && assistBladeResult != null;
                boolean hasValidBottom = (ratchetResult != null && bitResult != null)
                                || ratchetBitResult != null;

                if (!hasValidTop || !hasValidBottom) {
                        status = "Failure";
                        message = "One or more components not found";
                } else {
                        status = "Success";
                        message = "Combo expanded successfully";

                        // Top section
                        Map<String, Object> topResponse = new LinkedHashMap<>();
                        topResponse.put("lockChip", lockChipResult);

                        Map<String, Object> metalBladeResponse = new LinkedHashMap<>();
                        metalBladeResponse.put("metalBlade", metalBladeResult);
                        if (overBladeResult != null) {
                                metalBladeResponse.put("overBlade", overBladeResult);
                        }
                        topResponse.put("metalBlade", metalBladeResponse);
                        topResponse.put("assistBlade", assistBladeResult);

                        // Calculate combined top stats
                        int mbAtk = (int) metalBladeResult.get("atk");
                        int mbDef = (int) metalBladeResult.get("def");
                        int mbSta = (int) metalBladeResult.get("sta");
                        int abAtk = (int) assistBladeResult.get("atk");
                        int abDef = (int) assistBladeResult.get("def");
                        int abSta = (int) assistBladeResult.get("sta");
                        int topAtk = mbAtk + abAtk;
                        int topDef = mbDef + abDef;
                        int topSta = mbSta + abSta;
                        boolean topAtkHasZero = mbAtk == 0 || abAtk == 0;
                        boolean topDefHasZero = mbDef == 0 || abDef == 0;
                        boolean topStaHasZero = mbSta == 0 || abSta == 0;
                        if (overBladeResult != null) {
                                int obAtk = (int) overBladeResult.get("atk");
                                int obDef = (int) overBladeResult.get("def");
                                int obSta = (int) overBladeResult.get("sta");
                                topAtk += obAtk;
                                topDef += obDef;
                                topSta += obSta;
                                topAtkHasZero = topAtkHasZero || obAtk == 0;
                                topDefHasZero = topDefHasZero || obDef == 0;
                                topStaHasZero = topStaHasZero || obSta == 0;
                        }
                        topResponse.put("totalAtk", topAtkHasZero ? "TBA" : topAtk);
                        topResponse.put("totalDef", topDefHasZero ? "TBA" : topDef);
                        topResponse.put("totalSta", topStaHasZero ? "TBA" : topSta);

                        double lcWeight = (double) lockChipResult.get("weight");
                        double mbWeight = (double) metalBladeResult.get("weight");
                        double abWeight = (double) assistBladeResult.get("weight");
                        double topWeight = lcWeight + mbWeight + abWeight;
                        boolean topWeightHasZero = lcWeight == 0 || mbWeight == 0 || abWeight == 0;
                        if (overBladeResult != null) {
                                double obWeight = (double) overBladeResult.get("weight");
                                topWeight += obWeight;
                                topWeightHasZero = topWeightHasZero || obWeight == 0;
                        }
                        topResponse.put("totalWeight", topWeightHasZero ? "TBA"
                                        : String.format("%.2f", topWeight) + "g");

                        String spinDirection = (String) metalBladeResult.get("spindirection");
                        topResponse.put("spinDirection", spinDirection);

                        data.put("top", topResponse);

                        // Bottom section
                        Map<String, Object> bottomResponse = new LinkedHashMap<>();
                        double bottomWeight;
                        boolean bottomAtkHasZero;
                        boolean bottomDefHasZero;
                        boolean bottomStaHasZero;
                        boolean bottomWeightHasZero;
                        if (ratchetBitResult != null
                                        && requestedRatchetBitName != null && !requestedRatchetBitName.isEmpty()) {
                                bottomResponse.put("ratchetBit", ratchetBitResult);
                                int rbAtk = (int) ratchetBitResult.get("atk");
                                int rbDef = (int) ratchetBitResult.get("def");
                                int rbSta = (int) ratchetBitResult.get("sta");
                                bottomAtkHasZero = rbAtk == 0;
                                bottomDefHasZero = rbDef == 0;
                                bottomStaHasZero = rbSta == 0;
                                bottomResponse.put("totalAtk", bottomAtkHasZero ? "TBA" : rbAtk);
                                bottomResponse.put("totalDef", bottomDefHasZero ? "TBA" : rbDef);
                                bottomResponse.put("totalSta", bottomStaHasZero ? "TBA" : rbSta);
                                bottomResponse.put("height", (int) ratchetBitResult.get("height"));
                                bottomResponse.put("dash", (int) ratchetBitResult.get("dash"));
                                bottomResponse.put("burstRes", (int) ratchetBitResult.get("burstRes"));
                                bottomWeight = (double) ratchetBitResult.get("weight");
                                bottomWeightHasZero = bottomWeight == 0;
                                bottomResponse.put("totalWeight", bottomWeightHasZero ? "TBA"
                                                : String.format("%.2f", bottomWeight) + "g");
                        } else {
                                bottomResponse.put("ratchet", ratchetResult);
                                bottomResponse.put("bit", bitResult);
                                int rAtk = (int) ratchetResult.get("atk");
                                int rDef = (int) ratchetResult.get("def");
                                int rSta = (int) ratchetResult.get("sta");
                                int bAtk = (int) bitResult.get("atk");
                                int bDef = (int) bitResult.get("def");
                                int bSta = (int) bitResult.get("sta");
                                int bottomAtk = rAtk + bAtk;
                                int bottomDef = rDef + bDef;
                                int bottomSta = rSta + bSta;
                                bottomAtkHasZero = rAtk == 0 || bAtk == 0;
                                bottomDefHasZero = rDef == 0 || bDef == 0;
                                bottomStaHasZero = rSta == 0 || bSta == 0;
                                bottomResponse.put("totalAtk", bottomAtkHasZero ? "TBA" : bottomAtk);
                                bottomResponse.put("totalDef", bottomDefHasZero ? "TBA" : bottomDef);
                                bottomResponse.put("totalSta", bottomStaHasZero ? "TBA" : bottomSta);
                                bottomResponse.put("height", (int) ratchetResult.get("height"));
                                bottomResponse.put("dash", (int) bitResult.get("dash"));
                                bottomResponse.put("burstRes", (int) bitResult.get("burstRes"));
                                double rWeight = (double) ratchetResult.get("weight");
                                double bWeight = (double) bitResult.get("weight");
                                bottomWeight = rWeight + bWeight;
                                bottomWeightHasZero = rWeight == 0 || bWeight == 0;
                                bottomResponse.put("totalWeight", bottomWeightHasZero ? "TBA"
                                                : String.format("%.2f", bottomWeight) + "g");
                        }
                        data.put("bottom", bottomResponse);

                        // Grand totals
                        boolean grandAtkHasZero = topAtkHasZero || bottomAtkHasZero;
                        boolean grandDefHasZero = topDefHasZero || bottomDefHasZero;
                        boolean grandStaHasZero = topStaHasZero || bottomStaHasZero;
                        boolean grandWeightHasZero = topWeightHasZero || bottomWeightHasZero;
                        int grandAtk = topAtk + (bottomAtkHasZero ? 0 : (int) bottomResponse.get("totalAtk"));
                        int grandDef = topDef + (bottomDefHasZero ? 0 : (int) bottomResponse.get("totalDef"));
                        int grandSta = topSta + (bottomStaHasZero ? 0 : (int) bottomResponse.get("totalSta"));
                        double grandWeight = topWeight + bottomWeight;

                        Map<String, Object> totals = new LinkedHashMap<>();
                        totals.put("totalAtk", grandAtkHasZero ? "TBA" : grandAtk);
                        totals.put("totalDef", grandDefHasZero ? "TBA" : grandDef);
                        totals.put("totalSta", grandStaHasZero ? "TBA" : grandSta);
                        totals.put("totalWeight", grandWeightHasZero ? "TBA"
                                        : String.format("%.2f", grandWeight) + "g");
                        totals.put("ratchetBitMode", requestedRatchetBitMode);
                        totals.put("type", getType(grandAtk, grandDef, grandSta,
                                        ratchetBitResult != null && requestedRatchetBitName != null
                                                        && !requestedRatchetBitName.isEmpty()));
                        totals.put("spinDirection", spinDirection);
                        data.put("grandTotal", totals);

                        // Build combo name from codenames
                        StringBuilder comboName = new StringBuilder();
                        comboName.append((String) lockChipResult.get("codename"));
                        comboName.append((String) metalBladeResult.get("codename"));
                        if (overBladeResult != null) {
                                comboName.append((String) overBladeResult.get("codename"));
                        }
                        comboName.append((String) assistBladeResult.get("codename"));
                        if (ratchetBitResult != null
                                        && requestedRatchetBitName != null && !requestedRatchetBitName.isEmpty()) {
                                comboName.append((String) ratchetBitResult.get("codename"));
                        } else {
                                comboName.append((String) ratchetResult.get("name"));
                                comboName.append((String) bitResult.get("codename"));
                        }
                        data.put("name", comboName.toString());
                }

                mainResponse.put("status", status);
                mainResponse.put("message", message);
                mainResponse.put("data", data);
                mainResponse.put("createdDateTime", nowDateTime);

                return mainResponse;
        }

        private Map<String, Object> createBladeData(int atk, int def, int sta, double weight, String spindirection,
                        String name, String codename) {
                Map<String, Object> data = new LinkedHashMap<>();
                data.put("atk", atk);
                data.put("def", def);
                data.put("sta", sta);
                data.put("weight", weight);
                data.put("spindirection", spindirection);
                data.put("name", name);
                data.put("codename", codename);
                return data;
        }

        private List<Map<String, Object>> getLockChipData(String requestedLockChip) {
                List<Map<String, Object>> lockChipData = new ArrayList<>();
                lockChipData.add(createLockChipData("Dran", 1.7, "DRAN"));
                lockChipData.add(createLockChipData("Wizard", 1.7, "WIZARD"));
                lockChipData.add(createLockChipData("Perseus", 1.7, "PERSEUS"));
                lockChipData.add(createLockChipData("Hells", 1.7, "HELLS"));
                lockChipData.add(createLockChipData("Rhino", 1.7, "RHINO"));
                lockChipData.add(createLockChipData("Fox", 1.7, "FOX"));
                lockChipData.add(createLockChipData("Cerberus", 1.7, "CERBERUS"));
                lockChipData.add(createLockChipData("Whale", 1.7, "WHALE"));
                lockChipData.add(createLockChipData("Pegasus", 1.7, "PEGASUS"));
                lockChipData.add(createLockChipData("Sol", 1.7, "SOL"));
                lockChipData.add(createLockChipData("Wolf", 1.7, "WOLF"));
                lockChipData.add(createLockChipData("Emperor", 4.7, "EMPEROR"));
                lockChipData.add(createLockChipData("Phoenix", 1.7, "PHOENIX"));
                lockChipData.add(createLockChipData("Bahamuth", 1.7, "BAHAMUTH"));
                lockChipData.add(createLockChipData("Knight", 1.7, "KNIGHT"));
                lockChipData.add(createLockChipData("Ragna", 1.7, "RAGNA"));

                return lockChipData.stream()
                                .filter(lc -> lc.get("name").equals(requestedLockChip))
                                .collect(Collectors.toList());
        }

        private List<Map<String, Object>> getMainBladeData(String requestedMainBlade, String requestedMainBladeMode) {
                List<Map<String, Object>> mainBladeData = new ArrayList<>();
                mainBladeData.add(createMainBladeData(40, 10, 10, 31.2, "R", "Brave", "BRAVE"));
                mainBladeData.add(createMainBladeData(10, 10, 40, 29.4, "R", "Arc", "ARC"));
                mainBladeData.add(createMainBladeData(10, 40, 10, 30.3, "R", "Dark", "DARK"));
                mainBladeData.add(createMainBladeData(25, 10, 25, 29.0, "R", "Reaper", "REAPER"));
                mainBladeData.add(createMainBladeData(40, 15, 5, 30.3, "R", "Brush", "BRUSH"));
                mainBladeData.add(createMainBladeData(5, 15, 40, 28.5, "R", "Flame", "FLAME"));
                mainBladeData.add(createMainBladeData(50, 10, 15, 32.8, "R", "Blast", "BLAST"));
                mainBladeData.add(createMainBladeData(0, 0, 0, 32.3, "R", "Eclipse(Upper)", "ECLIPSE"));
                mainBladeData.add(createMainBladeData(0, 0, 0, 32.3, "R", "Eclipse(Smash)", "ECLIPSE"));
                mainBladeData.add(createMainBladeData(20, 10, 30, 31.6, "R", "Hunt", "HUNT"));
                mainBladeData.add(createMainBladeData(25, 25, 25, 33.1, "R", "Might", "MIGHT"));
                mainBladeData.add(createMainBladeData(25, 40, 10, 31.1, "R", "Flare", "FLARE"));

                String mainBladeLookup = requestedMainBlade +
                                (requestedMainBladeMode == null || requestedMainBladeMode.isEmpty()
                                                ? ""
                                                : "(" + requestedMainBladeMode + ")");

                return mainBladeData.stream()
                                .filter(mb -> mainBladeLookup.equals(mb.get("name")))
                                .collect(Collectors.toList());
        }

        private List<Map<String, Object>> getMetalBladeData(String requestedMetalBlade,
                        String requestedMetalBladeMode) {
                List<Map<String, Object>> metalBladeData = new ArrayList<>();
                metalBladeData.add(createMetalBladeData(25, 10, 5, 29.4, "R", "Blitz", "BLITZ"));
                metalBladeData.add(createMetalBladeData(10, 20, 10, 27.7, "R", "Fortress", "FORTRESS"));
                metalBladeData.add(createMetalBladeData(10, 10, 29, 27.4, "R", "Rage", "RAGE"));

                String metalBladeLookup = requestedMetalBlade +
                                (requestedMetalBladeMode == null || requestedMetalBladeMode.isEmpty()
                                                ? ""
                                                : "(" + requestedMetalBladeMode + ")");

                return metalBladeData.stream()
                                .filter(mb -> metalBladeLookup.equals(mb.get("name")))
                                .collect(Collectors.toList());
        }

        private List<Map<String, Object>> getOverBladeData(String requestedOverBlade, String requestedOverBladeMode) {
                List<Map<String, Object>> overBladeData = new ArrayList<>();
                overBladeData.add(createOverBladeData(10, 5, 5, 3.8, "R", "Break", "B"));
                overBladeData.add(createOverBladeData(5, 10, 5, 3.4, "R", "Guard", "G"));
                overBladeData.add(createOverBladeData(5, 5, 10, 3.7, "R", "Flow", "F"));

                String overBladeLookup = requestedOverBlade +
                                (requestedOverBladeMode == null || requestedOverBladeMode.isEmpty()
                                                ? ""
                                                : "(" + requestedOverBladeMode + ")");

                return overBladeData.stream()
                                .filter(ob -> overBladeLookup.equals(ob.get("name")))
                                .collect(Collectors.toList());
        }

        private List<Map<String, Object>> getAssistBladeData(String requestedAssistBlade,
                        String requestedAssistBladeMode) {
                List<Map<String, Object>> assistBladeData = new ArrayList<>();
                assistBladeData.add(createAssistBladeData(20, 10, 10, 4.7, 50, "R", "Slash", "S"));
                assistBladeData.add(createAssistBladeData(10, 10, 20, 4.7, 60, "R", "Round", "R"));
                assistBladeData.add(createAssistBladeData(10, 20, 10, 5.3, 60, "R", "Bumper", "B"));
                assistBladeData.add(createAssistBladeData(15, 10, 15, 5.8, 60, "R", "Turn(Rapid Hit)", "T"));
                assistBladeData.add(createAssistBladeData(10, 10, 20, 5.8, 60, "R", "Turn(Parry)", "T"));
                assistBladeData.add(createAssistBladeData(15, 20, 5, 5.0, 60, "R", "Charge", "C"));
                assistBladeData.add(createAssistBladeData(20, 15, 5, 4.9, 50, "R", "Jaggy", "J"));
                assistBladeData.add(createAssistBladeData(5, 15, 20, 7.2, 80, "R", "Wheel", "W"));
                assistBladeData.add(createAssistBladeData(15, 15, 10, 5.3, 60, "R", "Massive", "M"));
                assistBladeData.add(createAssistBladeData(25, 10, 5, 5.0, 60, "R", "Assault", "A"));
                assistBladeData.add(createAssistBladeData(0, 0, 0, 5.9, 0, "R", "Dual(Upper)", "D"));
                assistBladeData.add(createAssistBladeData(0, 0, 0, 5.9, 0, "R", "Dual(Smash)", "D"));
                assistBladeData.add(createAssistBladeData(5, 20, 25, 5.8, 60, "R", "Free", "F"));
                assistBladeData.add(createAssistBladeData(17, 17, 11, 7.8, 50, "R", "Heavy", "H"));
                assistBladeData.add(createAssistBladeData(0, 0, 0, 6.6, 0, "R", "Zillion", "Z"));
                assistBladeData.add(createAssistBladeData(10, 5, 25, 6.1, 70, "R", "Erase", "E"));
                assistBladeData.add(createAssistBladeData(0, 0, 0, 0, 0, "R", "Vertical", "V"));
                assistBladeData.add(createAssistBladeData(30, 5, 5, 4.9, 50, "R", "Knuckle", "K"));

                String assistBladeLookup = requestedAssistBlade +
                                (requestedAssistBladeMode == null || requestedAssistBladeMode.isEmpty()
                                                ? ""
                                                : "(" + requestedAssistBladeMode + ")");

                return assistBladeData.stream()
                                .filter(ab -> assistBladeLookup.equals(ab.get("name")))
                                .collect(Collectors.toList());
        }

        private List<Map<String, Object>> getRatchetData(String requestedRatchet) {
                List<Map<String, Object>> ratchetData = new ArrayList<>();
                ratchetData.add(createRatchetData(15, 9, 6, 60, 6.4, "3-60"));
                ratchetData.add(createRatchetData(11, 13, 6, 60, 6.4, "4-60"));
                ratchetData.add(createRatchetData(11, 11, 8, 80, 7.0, "4-80"));
                ratchetData.add(createRatchetData(15, 7, 8, 80, 7.1, "3-80"));
                ratchetData.add(createRatchetData(12, 9, 9, 60, 6.6, "5-60"));
                ratchetData.add(createRatchetData(12, 8, 10, 80, 7.2, "5-80"));
                ratchetData.add(createRatchetData(13, 10, 7, 60, 6.2, "9-60"));
                ratchetData.add(createRatchetData(13, 10, 7, 80, 6.8, "9-80"));
                ratchetData.add(createRatchetData(17, 9, 4, 60, 6.0, "1-60"));
                ratchetData.add(createRatchetData(15, 8, 7, 70, 6.4, "3-70"));
                ratchetData.add(createRatchetData(12, 9, 10, 70, 6.6, "5-70"));
                ratchetData.add(createRatchetData(11, 12, 7, 70, 6.5, "4-70"));
                ratchetData.add(createRatchetData(17, 4, 9, 80, 6.7, "1-80"));
                ratchetData.add(createRatchetData(16, 8, 6, 60, 6.2, "2-60"));
                ratchetData.add(createRatchetData(10, 11, 9, 80, 6.9, "2-80"));
                ratchetData.add(createRatchetData(8, 14, 8, 60, 7.1, "7-60"));
                ratchetData.add(createRatchetData(13, 10, 7, 70, 6.3, "9-70"));
                ratchetData.add(createRatchetData(10, 12, 8, 80, 6.4, "2-70"));
                ratchetData.add(createRatchetData(5, 15, 10, 85, 4.6, "3-85"));
                ratchetData.add(createRatchetData(8, 12, 10, 70, 7.3, "7-70"));
                ratchetData.add(createRatchetData(3, 12, 15, 80, 7.6, "0-80"));
                ratchetData.add(createRatchetData(7, 14, 9, 80, 7.8, "7-80"));
                ratchetData.add(createRatchetData(14, 8, 8, 60, 6.1, "6-60"));
                ratchetData.add(createRatchetData(7, 11, 12, 55, 4.8, "4-55"));
                ratchetData.add(createRatchetData(14, 6, 10, 80, 6.9, "6-80"));
                ratchetData.add(createRatchetData(3, 13, 14, 80, 7.0, "0-70"));
                ratchetData.add(createRatchetData(8, 19, 13, 85, 10.6, "M-85"));
                ratchetData.add(createRatchetData(14, 7, 9, 70, 7.3, "6-70"));
                ratchetData.add(createRatchetData(12, 13, 5, 50, 5.9, "4-50"));
                ratchetData.add(createRatchetData(17, 6, 7, 70, 7.3, "1-70"));
                ratchetData.add(createRatchetData(13, 10, 7, 65, 4.5, "9-65"));
                ratchetData.add(createRatchetData(3, 14, 13, 60, 6.5, "0-60"));
                ratchetData.add(createRatchetData(6, 14, 10, 55, 5.2, "7-55"));
                ratchetData.add(createRatchetData(8, 10, 12, 70, 0, "8-70"));
                ratchetData.add(createRatchetData(18, 9, 3, 50, 0, "1-50"));

                return ratchetData.stream()
                                .filter(r -> r.get("name").equals(requestedRatchet))
                                .collect(Collectors.toList());
        }

        private List<Map<String, Object>> getBitData(String requestedBit) {
                List<Map<String, Object>> bitData = new ArrayList<>();
                bitData.add(createBitData(40, 15, 10, 35, 80, 2.3, "Flat", "F"));
                bitData.add(createBitData(35, 20, 20, 25, 80, 2.2, "Taper", "T"));
                bitData.add(createBitData(15, 25, 50, 10, 30, 2.1, "Ball", "B"));
                bitData.add(createBitData(10, 50, 30, 10, 30, 2.0, "Needle", "N"));
                bitData.add(createBitData(15, 55, 20, 10, 30, 2.2, "High Needle", "HN"));
                bitData.add(createBitData(45, 5, 10, 40, 80, 2.1, "Low Flat", "LF"));
                bitData.add(createBitData(25, 25, 25, 25, 80, 2.2, "Point", "P"));
                bitData.add(createBitData(10, 30, 50, 10, 30, 2.0, "Orb", "O"));
                bitData.add(createBitData(10, 45, 35, 10, 30, 2.0, "Spike", "S"));
                bitData.add(createBitData(40, 10, 20, 30, 80, 2.1, "Rush", "R"));
                bitData.add(createBitData(30, 25, 20, 25, 80, 2.2, "High Taper", "HT"));
                bitData.add(createBitData(50, 5, 5, 40, 80, 2.3, "Gear Flat", "GF"));
                bitData.add(createBitData(10, 15, 45, 30, 30, 2.1, "Gear Ball", "GB"));
                bitData.add(createBitData(30, 25, 15, 30, 80, 2.3, "Gear Point", "GP"));
                bitData.add(createBitData(20, 40, 10, 30, 30, 2.0, "Gear Needle", "GN"));
                bitData.add(createBitData(40, 10, 10, 40, 80, 2.6, "Accel", "A"));
                bitData.add(createBitData(30, 35, 20, 15, 80, 2.6, "Hexa", "H"));
                bitData.add(createBitData(15, 20, 55, 10, 30, 3.2, "Disc Ball", "DB"));
                bitData.add(createBitData(55, 15, 5, 25, 80, 2.2, "Quake", "Q"));
                bitData.add(createBitData(8, 57, 30, 5, 30, 2.8, "Metal Needle", "MN"));
                bitData.add(createBitData(25, 25, 30, 20, 80, 2.1, "Unite", "U"));
                bitData.add(createBitData(40, 5, 10, 45, 80, 2.1, "Cyclone", "C"));
                bitData.add(createBitData(10, 55, 25, 10, 30, 2.0, "Dot", "D"));
                bitData.add(createBitData(20, 10, 55, 15, 30, 2.5, "Glide", "G"));
                bitData.add(createBitData(30, 15, 20, 35, 30, 3.2, "Elevate", "E"));
                bitData.add(createBitData(10, 25, 60, 5, 30, 1.9, "Free Ball", "FB"));
                bitData.add(createBitData(35, 25, 25, 15, 80, 2.2, "Trans Point", "TP"));
                bitData.add(createBitData(40, 5, 15, 40, 80, 2.7, "Level", "L"));
                bitData.add(createBitData(5, 60, 30, 5, 30, 2.0, "Bound Spike", "BS"));
                bitData.add(createBitData(60, 17, 3, 20, 80, 3.1, "Rubber Accel", "RA"));
                bitData.add(createBitData(45, 5, 15, 35, 80, 1.9, "Low Rush", "LR"));
                bitData.add(createBitData(10, 60, 20, 10, 30, 1.9, "Under Needle", "UN"));
                bitData.add(createBitData(45, 10, 5, 40, 80, 2.2, "Vortex", "V"));
                bitData.add(createBitData(5, 25, 55, 15, 30, 1.9, "Low Orb", "LO"));
                bitData.add(createBitData(5, 55, 30, 10, 30, 1.8, "Wedge", "W"));
                bitData.add(createBitData(35, 25, 15, 25, 80, 2.2, "Kick", "K"));
                bitData.add(createBitData(45, 10, 10, 35, 80, 2.1, "Gear Rush", "GR"));
                bitData.add(createBitData(30, 20, 15, 35, 80, 2.5, "Zap", "Z"));
                bitData.add(createBitData(15, 30, 45, 10, 30, 2.4, "Wall Ball", "WB"));
                bitData.add(createBitData(50, 20, 10, 45, 80, 3.4, "Merge", "M"));
                bitData.add(createBitData(55, 5, 5, 35, 80, 2.0, "Under Flat", "UF"));
                bitData.add(createBitData(35, 30, 20, 15, 80, 2.3, "Trans Kick", "TK"));
                bitData.add(createBitData(35, 10, 15, 40, 80, 2.6, "Jolt", "J"));
                bitData.add(createBitData(5, 60, 25, 10, 30, 2.4, "Wall Wedge", "WW"));
                bitData.add(createBitData(10, 15, 65, 10, 30, 0, "Yielding", "Y"));
                bitData.add(createBitData(50, 15, 5, 30, 80, 2.4, "Ignition", "I"));
                bitData.add(createBitData(40, 15, 15, 30, 80, 0, "Free Flat", "FF"));

                return bitData.stream()
                                .filter(b -> b.get("name").equals(requestedBit))
                                .collect(Collectors.toList());
        }

        private List<Map<String, Object>> getRatchetBitData(String requestedRatchetBit) {
                List<Map<String, Object>> ratchetBitData = new ArrayList<>();
                ratchetBitData.add(createRatchetBitData(30, 30, 60, 10, 30, 65, 12.7, "Turbo(Low)", "Tr"));
                ratchetBitData.add(createRatchetBitData(55, 20, 10, 45, 30, 90, 12.7, "Turbo(High)", "Tr"));
                ratchetBitData.add(createRatchetBitData(20, 50, 50, 10, 30, 85, 14.1, "Operate(Defense)", "Op"));
                ratchetBitData.add(createRatchetBitData(50, 35, 10, 35, 30, 80, 14.1, "Operate(Attack)", "Op"));

                return ratchetBitData.stream()
                                .filter(rb -> rb.get("name").equals(requestedRatchetBit))
                                .collect(Collectors.toList());
        }

        private List<Map<String, Object>> getBladeData(String requestedBlade) {
                List<Map<String, Object>> bladeData = new ArrayList<>();
                bladeData.add(createBladeData(55, 25, 20, 34.6, "R", "Dran Sword", "DRANSWORD"));
                bladeData.add(createBladeData(30, 35, 35, 33.0, "R", "Hells Scythe", "HELLSSCYTHE"));
                bladeData.add(createBladeData(15, 30, 55, 31.8, "R", "Wizard Arrow", "WIZARDARROW"));
                bladeData.add(createBladeData(20, 55, 25, 32.4, "R", "Knight Shield", "KNIGHTSHIELD"));
                bladeData.add(createBladeData(35, 30, 35, 27.7, "R", "Dranzer Spiral", "DRANZERSPIRAL"));
                bladeData.add(createBladeData(25, 60, 15, 32.9, "R", "Knight Lance", "KNIGHTLANCE"));
                bladeData.add(createBladeData(60, 25, 15, 34.5, "R", "Shark Edge", "SHARKEDGE"));
                bladeData.add(createBladeData(40, 40, 20, 31.4, "R", "Leon Claw", "LEONCLAW"));
                bladeData.add(createBladeData(30, 20, 50, 34.7, "R", "Viper Tail", "VIPERTAIL"));
                bladeData.add(createBladeData(20, 50, 30, 32.7, "R", "Rhino Horn", "RHINOHORN"));
                bladeData.add(createBladeData(50, 25, 25, 34.7, "R", "Dran Dagger", "DRANDAGGER"));
                bladeData.add(createBladeData(35, 40, 25, 33.2, "R", "Hells Chain", "HELLSCHAIN"));
                bladeData.add(createBladeData(65, 30, 20, 38.0, "R", "Phoenix Wing", "PHOENIXWING"));
                bladeData.add(createBladeData(10, 40, 50, 31.9, "R", "Wyvern Gale", "WYVERNGALE"));
                bladeData.add(createBladeData(35, 35, 30, 33.4, "R", "Unicorn Sting", "UNICORNSTING"));
                bladeData.add(createBladeData(35, 55, 10, 32.7, "R", "Sphinx Cowl", "SPHINXCOWL"));
                bladeData.add(createBladeData(70, 20, 10, 36.5, "R", "Dran Buster", "DRANBUSTER"));
                bladeData.add(createBladeData(50, 25, 25, 33.0, "R", "Hells Hammer", "HELLSHAMMER"));
                bladeData.add(createBladeData(15, 25, 60, 35.3, "R", "Wizard Rod", "WIZARDROD"));
                bladeData.add(createBladeData(40, 35, 25, 28.6, "R", "Driger Slash", "DRIGERSLASH"));
                bladeData.add(createBladeData(65, 30, 5, 37.0, "R", "Tyranno Beat", "TYRANNOBEAT"));
                bladeData.add(createBladeData(10, 70, 20, 28.2, "R", "Shinobi Shadow", "SHINOBISHADOW"));
                bladeData.add(createBladeData(45, 30, 25, 34.6, "R", "Weiss Tiger", "WEISSTIGER"));
                bladeData.add(createBladeData(60, 15, 25, 38.0, "L", "Cobalt Dragoon", "COBALTDRAGOON"));
                bladeData.add(createBladeData(10, 65, 25, 32.1, "R", "Black Shell", "BLACKSHELL"));
                bladeData.add(createBladeData(15, 70, 15, 35.0, "R", "Leon Crest", "LEONCREST"));
                bladeData.add(createBladeData(10, 35, 55, 34.5, "R", "Phoenix Rudder", "PHOENIXRUDDER"));
                bladeData.add(createBladeData(55, 25, 20, 42.3, "L", "Lightning L-Drago(Upper)", "LIGHTNING L-DRAGO"));
                bladeData.add(createBladeData(50, 30, 20, 33.5, "L", "Lightning L-Drago(Rapid Hit)", "LIGHTNING L-DRAGO"));
                bladeData.add(createBladeData(45, 35, 20, 38.2, "R", "Whale Wave", "WHALEWAVE"));
                bladeData.add(createBladeData(15, 30, 65, 36.8, "R", "Silver Wolf", "SILVERWOLF"));
                bladeData.add(createBladeData(25, 45, 30, 29.6, "R", "Bear Scratch", "BEARSCRATCH"));
                bladeData.add(createBladeData(45, 25, 20, 35.0, "R", "Crimson Garuda", "CRIMSONGARUDA"));
                bladeData.add(createBladeData(65, 20, 25, 36.5, "R", "Samurai Saber", "SAMURAISABER"));
                bladeData.add(createBladeData(10, 65, 35, 36.5, "R", "Knight Mail", "KNIGHTMAIL"));
                bladeData.add(createBladeData(27, 23, 50, 34.3, "R", "Ptera Swing", "PTERASWING"));
                bladeData.add(createBladeData(38, 40, 37, 32.0, "R", "Mammoth Tusk", "MAMMOTHTUSK"));
                bladeData.add(createBladeData(75, 25, 10, 39.0, "R", "Impact Drake", "IMPACTDRAKE"));
                bladeData.add(createBladeData(5, 40, 55, 26.7, "R", "Ghost Circle", "GHOSTCIRCLE"));
                bladeData.add(createBladeData(30, 50, 20, 28.0, "R", "Draciel Shield", "DRACIELSHIELD"));
                bladeData.add(createBladeData(30, 60, 10, 34.0, "R", "Golem Rock", "GOLEMROCK"));
                bladeData.add(createBladeData(25, 40, 35, 32.6, "R", "Shelter Drake", "SHELTERDRAKE"));
                bladeData.add(createBladeData(50, 20, 30, 33.3, "R", "Phoenix Feather", "PHOENIXFEATHER"));
                bladeData.add(createBladeData(65, 25, 10, 31.0, "R", "Xeno Xcalibur", "XENOXCALIBUR"));
                bladeData.add(createBladeData(25, 55, 30, 39.7, "R", "Scorpio Spear(Defense)", "SCORPIOSPEAR"));
                bladeData.add(createBladeData(55, 25, 30, 39.7, "R", "Scorpio Spear(Attack)", "SCORPIOSPEAR"));
                bladeData.add(createBladeData(20, 65, 15, 36.5, "R", "Tricera Press", "TRICERAPRESS"));
                bladeData.add(createBladeData(30, 55, 15, 29.8, "R", "Rock Leone", "ROCK LEONE"));
                bladeData.add(createBladeData(40, 30, 30, 36.0, "R", "Samurai Calibur", "SAMURAICALIBUR"));
                bladeData.add(createBladeData(70, 15, 15, 37.6, "R", "Shark Scale", "SHARKSCALE"));
                bladeData.add(createBladeData(60, 28, 12, 36.0, "R", "Tyranno Roar", "TYRANNOROAR"));
                bladeData.add(createBladeData(70, 35, 25, 37.3, "R", "Cobalt Drake", "COBALTDRAKE"));
                bladeData.add(createBladeData(13, 65, 22, 31.5, "R", "Goat Tackle", "GOATTACKLE"));
                bladeData.add(createBladeData(10, 10, 80, 37.6, "R", "Clock Mirage", "CLOCKMIRAGE"));
                bladeData.add(createBladeData(20, 25, 55, 29.6, "R", "Shark Gill", "SHARKGILL"));
                bladeData.add(createBladeData(75, 15, 35, 39.0, "R", "Meteor Dragoon", "METEORDRAGOON"));
                bladeData.add(createBladeData(30, 60, 20, 37.5, "R", "Mummy Curse", "MUMMYCURSE"));
                bladeData.add(createBladeData(55, 30, 15, 25.1, "L", "Dragoon Storm", "DRAGOONSTORM"));
                bladeData.add(createBladeData(30, 40, 30, 0, "R", "Storm Spriggan", "STORMSPRIGGAN"));
                bladeData.add(createBladeData(45, 45, 40, 0, "R", "Bullet Griffon", "BULLETGRIFFON"));
                bladeData.add(createBladeData(58, 25, 17, 0, "R", "Dran Strike", "DRANSTRIKE"));

                return bladeData.stream()
                                .filter(blade -> blade.get("name").equals(requestedBlade))
                                .collect(Collectors.toList());
        }

        private String getType(int totalAtk, int totalDef, int totalSta, boolean isRatchetBit) {
                if (isRatchetBit) {
                        if (totalAtk >= 100 && totalDef >= 100 && totalSta >= 100) {
                                return "Ultimate Balance";
                        } else if ((totalAtk >= 100 && totalDef >= 100)
                                        || (totalAtk >= 100 && totalSta >= 100)
                                        || (totalDef >= 100 && totalSta >= 100)) {
                                return "Perfect Balance";
                        } else if (totalAtk >= 100 && totalDef < 100 && totalSta < 100) {
                                return "Attack";
                        } else if (totalAtk < 100 && totalDef >= 100 && totalSta < 100) {
                                return "Defense";
                        } else if (totalAtk < 100 && totalDef < 100 && totalSta >= 100) {
                                return "Stamina";
                        } else {
                                return "Balance";
                        }
                } else {
                        if (totalAtk >= 100 && totalDef >= 100 && totalSta >= 100) {
                                return "Balance III";
                        } else if ((totalAtk >= 100 && totalDef >= 100)
                                        || (totalAtk >= 100 && totalSta >= 100)
                                        || (totalDef >= 100 && totalSta >= 100)) {
                                return "Balance II";
                        } else if (totalAtk >= 100 && totalDef < 100 && totalSta < 100) {
                                return "Attack";
                        } else if (totalAtk < 100 && totalDef >= 100 && totalSta < 100) {
                                return "Defense";
                        } else if (totalAtk < 100 && totalDef < 100 && totalSta >= 100) {
                                return "Stamina";
                        } else {
                                return "Balance";
                        }
                }
        }

        private Map<String, Object> createLockChipData(String name, double weight, String codename) {
                Map<String, Object> data = new LinkedHashMap<>();
                data.put("name", name);
                data.put("weight", weight);
                data.put("codename", codename);
                return data;
        }

        private Map<String, Object> createMainBladeData(int atk, int def, int sta, double weight, String spindirection,
                        String name, String codename) {
                Map<String, Object> data = new LinkedHashMap<>();
                data.put("atk", atk);
                data.put("def", def);
                data.put("sta", sta);
                data.put("weight", weight);
                data.put("spindirection", spindirection);
                data.put("name", name);
                data.put("codename", codename);
                return data;
        }

        private Map<String, Object> createMetalBladeData(int atk, int def, int sta, double weight, String spindirection,
                        String name, String codename) {
                Map<String, Object> data = new LinkedHashMap<>();
                data.put("atk", atk);
                data.put("def", def);
                data.put("sta", sta);
                data.put("weight", weight);
                data.put("spindirection", spindirection);
                data.put("name", name);
                data.put("codename", codename);
                return data;
        }

        private Map<String, Object> createOverBladeData(int atk, int def, int sta, double weight,
                        String spindirection,
                        String name, String codename) {
                Map<String, Object> data = new LinkedHashMap<>();
                data.put("atk", atk);
                data.put("def", def);
                data.put("sta", sta);
                data.put("weight", weight);
                data.put("spindirection", spindirection);
                data.put("name", name);
                data.put("codename", codename);
                return data;
        }

        private Map<String, Object> createAssistBladeData(int atk, int def, int sta, double weight, int height,
                        String spindirection,
                        String name, String codename) {
                Map<String, Object> data = new LinkedHashMap<>();
                data.put("atk", atk);
                data.put("def", def);
                data.put("sta", sta);
                data.put("weight", weight);
                data.put("height", height);
                data.put("spindirection", spindirection);
                data.put("name", name);
                data.put("codename", codename);
                return data;
        }

        private Map<String, Object> createRatchetData(int atk, int def, int sta, int height, double weight,
                        String name) {
                Map<String, Object> data = new LinkedHashMap<>();
                data.put("atk", atk);
                data.put("def", def);
                data.put("sta", sta);
                data.put("height", height);
                data.put("weight", weight);
                data.put("name", name);
                return data;
        }

        private Map<String, Object> createBitData(int atk, int def, int sta, int dash, int burstRes, double weight,
                        String name, String codename) {
                Map<String, Object> data = new LinkedHashMap<>();
                data.put("atk", atk);
                data.put("def", def);
                data.put("sta", sta);
                data.put("dash", dash);
                data.put("burstRes", burstRes);
                data.put("weight", weight);
                data.put("name", name);
                data.put("codename", codename);
                return data;
        }

        private Map<String, Object> createRatchetBitData(int atk, int def, int sta, int dash, int burstRes, int height,
                        double weight,
                        String name, String codename) {
                Map<String, Object> data = new LinkedHashMap<>();
                data.put("atk", atk);
                data.put("def", def);
                data.put("sta", sta);
                data.put("dash", dash);
                data.put("burstRes", burstRes);
                data.put("height", height);
                data.put("weight", weight);
                data.put("name", name);
                data.put("codename", codename);
                return data;
        }
}
